import { createHash } from 'crypto';
import { query, withTransaction } from '../db.js';

/**
 * Distribution Mechanism -- One of 5 Immutable Components (spec S13, Phase 3)
 * NO AI. Deterministic only. Separate credentials from agents.
 *
 * Handles:
 *  - Recipient selection (random, from eligible pool)
 *  - Fund transfer (via licensed distribution partner)
 *  - 40/20/40 split: 40% reinvestment, 20% data contribution fees, 40% random distribution
 *
 * Article 3.7: Distributions via licensed money transmission partner (handles KYC, OFAC, tax reporting).
 * Article 3.8: Allocation formula encoded as CHECK constraints in autobot_finance schema.
 *
 * Pre-distribution activation gate: 40/20/40 split cannot activate until
 * trailing 3-month average net revenue exceeds 150% of trailing 3-month average operating costs.
 */

// ============================================================
// Helpers
// ============================================================

/**
 * Banker's rounding (round half to even) for monetary precision.
 * Matches autobot_finance.bankers_round() behavior on the JS side.
 */
function bankersRound(value, decimals = 6) {
  const multiplier = Math.pow(10, decimals);
  const shifted = value * multiplier;
  const truncated = Math.trunc(shifted);
  const remainder = Math.abs(shifted - truncated);

  // If exactly 0.5, round to even
  if (Math.abs(remainder - 0.5) < 1e-9) {
    if (truncated % 2 === 0) {
      return truncated / multiplier;
    }
    return (truncated + Math.sign(shifted)) / multiplier;
  }

  return Math.round(shifted) / multiplier;
}

/**
 * Compute SHA-256 hash for ledger chain integrity.
 */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Build hash chain entry. Each entry's hash covers: previous hash + entry data.
 */
function computeLedgerHash(prevHash, entryType, roundId, transactionId, amount, description) {
  const payload = [
    prevHash || 'GENESIS',
    entryType,
    roundId || '',
    transactionId || '',
    String(amount),
    description || '',
  ].join('|');
  return sha256(payload);
}

/**
 * Append an entry to the distribution ledger with hash chain.
 */
async function appendLedgerEntry(client, entryType, roundId, transactionId, amount, description) {
  const prevResult = await client.query(
    `SELECT hash_chain_current FROM autobot_distrib.distribution_ledger
     ORDER BY recorded_at DESC LIMIT 1`
  );
  const prevHash = prevResult.rows[0]?.hash_chain_current || null;
  const currentHash = computeLedgerHash(prevHash, entryType, roundId, transactionId, amount, description);

  await client.query(
    `INSERT INTO autobot_distrib.distribution_ledger
     (entry_type, round_id, transaction_id, amount, description, hash_chain_prev, hash_chain_current)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entryType, roundId, transactionId, amount, description, prevHash, currentHash]
  );

  return currentHash;
}

/**
 * Format a date to first-of-month string for period_month columns.
 */
function formatMonth(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// ============================================================
// Public API
// ============================================================

/**
 * Initiate a distribution round for a given period month.
 * Creates a round from monthly_allocations data after checking the activation gate.
 *
 * @param {string|Date} periodMonth - The month to distribute for (e.g. '2026-01-01' or Date)
 * @returns {object} Round details or gate failure info
 */
export async function initiateDistributionRound(periodMonth) {
  const monthStr = formatMonth(periodMonth);

  try {
    // Step 1: Check the pre-distribution activation gate
    const gateResult = await query(
      `SELECT
         AVG(gross_revenue) as avg_revenue,
         AVG(total_expenses) as avg_expenses
       FROM autobot_finance.monthly_allocations
       WHERE period_month >= ($1::date - interval '3 months')
         AND period_month < $1::date`,
      [monthStr]
    );

    if (!gateResult.rows[0] || !gateResult.rows[0].avg_revenue) {
      return { created: false, reason: 'Insufficient allocation history for activation gate' };
    }

    const avgRevenue = parseFloat(gateResult.rows[0].avg_revenue);
    const avgExpenses = parseFloat(gateResult.rows[0].avg_expenses || 0);
    const threshold = avgExpenses * 1.5;

    if (avgRevenue <= 0 || avgRevenue <= threshold) {
      return {
        created: false,
        reason: 'Activation gate not met: trailing 3-month avg revenue must exceed 150% of trailing 3-month avg costs',
        avgRevenue,
        avgExpenses,
        threshold,
        ratio: avgExpenses > 0 ? avgRevenue / avgExpenses : 0,
      };
    }

    // Step 2: Fetch the monthly allocation for this period
    const allocResult = await query(
      `SELECT id, net_profit, reinvestment, data_contribution_fees, random_distribution, distribution_eligible
       FROM autobot_finance.monthly_allocations
       WHERE period_month = $1::date`,
      [monthStr]
    );

    if (!allocResult.rows[0]) {
      return { created: false, reason: `No monthly allocation found for ${monthStr}` };
    }

    const alloc = allocResult.rows[0];

    if (!alloc.distribution_eligible) {
      return { created: false, reason: 'Monthly allocation is not marked distribution_eligible' };
    }

    const netProfit = parseFloat(alloc.net_profit);
    if (netProfit <= 0) {
      return { created: false, reason: 'Net profit is zero or negative; nothing to distribute' };
    }

    // Step 3: Check for existing round (idempotency)
    const existingResult = await query(
      `SELECT id, status FROM autobot_distrib.distribution_rounds
       WHERE period_month = $1::date`,
      [monthStr]
    );

    if (existingResult.rows[0]) {
      const existing = existingResult.rows[0];
      return {
        created: false,
        reason: `Round already exists for ${monthStr}`,
        roundId: existing.id,
        status: existing.status,
      };
    }

    // Step 4: Create the round within a transaction + ledger entry
    const round = await withTransaction(async (client) => {
      const insertResult = await client.query(
        `INSERT INTO autobot_distrib.distribution_rounds
         (period_month, allocation_id, total_amount, reinvestment_amount, data_fees_amount, random_amount, status)
         VALUES ($1::date, $2, $3, $4, $5, $6, 'pending')
         RETURNING id, period_month, total_amount, reinvestment_amount, data_fees_amount, random_amount, status, created_at`,
        [
          monthStr,
          alloc.id,
          netProfit,
          parseFloat(alloc.reinvestment),
          parseFloat(alloc.data_contribution_fees),
          parseFloat(alloc.random_distribution),
        ]
      );

      const newRound = insertResult.rows[0];

      await appendLedgerEntry(
        client,
        'round_initiated',
        newRound.id,
        null,
        netProfit,
        `Distribution round initiated for ${monthStr}. Total: ${netProfit}. Split: reinvest=${alloc.reinvestment}, data_fees=${alloc.data_contribution_fees}, random=${alloc.random_distribution}`
      );

      return newRound;
    });

    return {
      created: true,
      roundId: round.id,
      periodMonth: round.period_month,
      totalAmount: parseFloat(round.total_amount),
      reinvestmentAmount: parseFloat(round.reinvestment_amount),
      dataFeesAmount: parseFloat(round.data_fees_amount),
      randomAmount: parseFloat(round.random_amount),
      status: round.status,
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { created: false, reason: 'Distribution or finance schema not ready' };
    }
    throw err;
  }
}

/**
 * Select random eligible recipients for the random distribution portion of a round.
 * Uses a deterministic seed derived from the round ID for reproducibility.
 *
 * @param {string} roundId - The distribution round ID
 * @param {number} count - Number of recipients to select
 * @returns {object} Selected recipients or error info
 */
export async function selectRandomRecipients(roundId, count) {
  if (!roundId || count <= 0) {
    return { selected: false, reason: 'Invalid roundId or count' };
  }

  try {
    // Verify round exists and is in valid state
    const roundResult = await query(
      `SELECT id, status, random_amount FROM autobot_distrib.distribution_rounds WHERE id = $1`,
      [roundId]
    );

    if (!roundResult.rows[0]) {
      return { selected: false, reason: `Round ${roundId} not found` };
    }

    const round = roundResult.rows[0];
    if (round.status !== 'pending' && round.status !== 'approved') {
      return { selected: false, reason: `Round is in ${round.status} state; cannot select recipients` };
    }

    // Deterministic seed from round ID for reproducible selection
    const seedHash = sha256(roundId);
    const seed = parseInt(seedHash.slice(0, 8), 16) / 0xFFFFFFFF;

    // Set seed first, then select -- two queries for driver compatibility
    await query(`SELECT setseed($1)`, [seed]);

    const selectedResult = await query(
      `SELECT id, recipient_type, external_id
       FROM autobot_distrib.recipients
       WHERE eligibility_status = 'eligible' AND recipient_type = 'random_individual'
       ORDER BY random()
       LIMIT $1`,
      [count]
    );

    const recipients = selectedResult.rows;

    if (recipients.length === 0) {
      return { selected: false, reason: 'No eligible random_individual recipients found' };
    }

    // Compute per-recipient amount (equal split with banker's rounding)
    const randomAmount = parseFloat(round.random_amount);
    const perRecipient = bankersRound(randomAmount / recipients.length, 6);
    const remainder = bankersRound(randomAmount - perRecipient * recipients.length, 6);

    // Create transactions within a transaction
    const transactions = await withTransaction(async (client) => {
      const txns = [];

      for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i];
        // Last recipient absorbs rounding remainder
        const amount = i === recipients.length - 1
          ? bankersRound(perRecipient + remainder, 6)
          : perRecipient;

        const txnResult = await client.query(
          `INSERT INTO autobot_distrib.distribution_transactions
           (round_id, recipient_id, amount, transaction_type, status)
           VALUES ($1, $2, $3, 'random_distribution', 'pending')
           RETURNING id, recipient_id, amount`,
          [roundId, recipient.id, amount]
        );

        const txn = txnResult.rows[0];
        txns.push(txn);

        await appendLedgerEntry(
          client,
          'random_distribution_created',
          roundId,
          txn.id,
          amount,
          `Random distribution transaction created for recipient ${recipient.id}`
        );
      }

      return txns;
    });

    return {
      selected: true,
      roundId,
      recipientCount: recipients.length,
      perRecipientAmount: perRecipient,
      transactions: transactions.map(t => ({
        transactionId: t.id,
        recipientId: t.recipient_id,
        amount: parseFloat(t.amount),
      })),
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { selected: false, reason: 'Distribution schema not ready' };
    }
    throw err;
  }
}

/**
 * Compute data contribution fees for a distribution round.
 * Allocates the data_fees_amount proportionally based on contribution volume.
 *
 * @param {string} roundId - The distribution round ID
 * @returns {object} Computed fees or error info
 */
export async function computeDataContributionFees(roundId) {
  if (!roundId) {
    return { computed: false, reason: 'Invalid roundId' };
  }

  try {
    // Fetch round details
    const roundResult = await query(
      `SELECT id, status, data_fees_amount FROM autobot_distrib.distribution_rounds WHERE id = $1`,
      [roundId]
    );

    if (!roundResult.rows[0]) {
      return { computed: false, reason: `Round ${roundId} not found` };
    }

    const round = roundResult.rows[0];
    if (round.status !== 'pending' && round.status !== 'approved') {
      return { computed: false, reason: `Round is in ${round.status} state; cannot compute fees` };
    }

    const totalDataFees = parseFloat(round.data_fees_amount);
    if (totalDataFees <= 0) {
      return { computed: true, roundId, totalDataFees: 0, transactions: [] };
    }

    // Fetch eligible data contributors
    const contributorResult = await query(
      `SELECT id, recipient_type, external_id
       FROM autobot_distrib.recipients
       WHERE eligibility_status = 'eligible' AND recipient_type = 'data_contributor'
       ORDER BY created_at ASC`
    );

    const contributors = contributorResult.rows;

    if (contributors.length === 0) {
      return { computed: false, reason: 'No eligible data contributors found' };
    }

    // Equal split among contributors (proportional by volume deferred until
    // contribution tracking is implemented; equal split is the baseline).
    const perContributor = bankersRound(totalDataFees / contributors.length, 6);
    const remainder = bankersRound(totalDataFees - perContributor * contributors.length, 6);

    const transactions = await withTransaction(async (client) => {
      const txns = [];

      for (let i = 0; i < contributors.length; i++) {
        const contributor = contributors[i];
        // Last contributor absorbs rounding remainder
        const amount = i === contributors.length - 1
          ? bankersRound(perContributor + remainder, 6)
          : perContributor;

        const txnResult = await client.query(
          `INSERT INTO autobot_distrib.distribution_transactions
           (round_id, recipient_id, amount, transaction_type, status)
           VALUES ($1, $2, $3, 'data_contribution_fee', 'pending')
           RETURNING id, recipient_id, amount`,
          [roundId, contributor.id, amount]
        );

        const txn = txnResult.rows[0];
        txns.push(txn);

        await appendLedgerEntry(
          client,
          'data_fee_created',
          roundId,
          txn.id,
          amount,
          `Data contribution fee transaction created for contributor ${contributor.id}`
        );
      }

      return txns;
    });

    return {
      computed: true,
      roundId,
      totalDataFees,
      contributorCount: contributors.length,
      perContributorAmount: perContributor,
      transactions: transactions.map(t => ({
        transactionId: t.id,
        recipientId: t.recipient_id,
        amount: parseFloat(t.amount),
      })),
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { computed: false, reason: 'Distribution schema not ready' };
    }
    throw err;
  }
}

/**
 * Submit a distribution round to the licensed partner for processing.
 * Marks all pending transactions as 'submitted'.
 * Actual partner API integration is deferred -- this records intent.
 *
 * Article 3.7: Licensed money transmission partner handles KYC, OFAC, tax reporting.
 *
 * @param {string} roundId - The distribution round ID
 * @returns {object} Submission result
 */
export async function submitToPartner(roundId) {
  if (!roundId) {
    return { submitted: false, reason: 'Invalid roundId' };
  }

  try {
    // Verify round exists and is approved
    const roundResult = await query(
      `SELECT id, status, total_amount FROM autobot_distrib.distribution_rounds WHERE id = $1`,
      [roundId]
    );

    if (!roundResult.rows[0]) {
      return { submitted: false, reason: `Round ${roundId} not found` };
    }

    const round = roundResult.rows[0];
    if (round.status !== 'approved') {
      return { submitted: false, reason: `Round must be 'approved' to submit; current status: ${round.status}` };
    }

    // Count pending transactions
    const pendingResult = await query(
      `SELECT COUNT(*) as count FROM autobot_distrib.distribution_transactions
       WHERE round_id = $1 AND status = 'pending'`,
      [roundId]
    );

    const pendingCount = parseInt(pendingResult.rows[0].count);
    if (pendingCount === 0) {
      return { submitted: false, reason: 'No pending transactions to submit' };
    }

    // Mark all pending transactions as submitted and round as processing
    const result = await withTransaction(async (client) => {
      await client.query(
        `UPDATE autobot_distrib.distribution_transactions
         SET status = 'submitted'
         WHERE round_id = $1 AND status = 'pending'`,
        [roundId]
      );

      await client.query(
        `UPDATE autobot_distrib.distribution_rounds
         SET status = 'processing'
         WHERE id = $1`,
        [roundId]
      );

      await appendLedgerEntry(
        client,
        'round_submitted',
        roundId,
        null,
        parseFloat(round.total_amount),
        `Distribution round submitted to partner. ${pendingCount} transactions marked as submitted.`
      );

      return { transactionsSubmitted: pendingCount };
    });

    return {
      submitted: true,
      roundId,
      transactionsSubmitted: result.transactionsSubmitted,
      status: 'processing',
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { submitted: false, reason: 'Distribution schema not ready' };
    }
    throw err;
  }
}

/**
 * Get the distribution status for a given period month.
 *
 * @param {string|Date} periodMonth - The month to check
 * @returns {object|null} Round status with transaction summary, or null if no round exists
 */
export async function getDistributionStatus(periodMonth) {
  const monthStr = formatMonth(periodMonth);

  try {
    const roundResult = await query(
      `SELECT id, period_month, allocation_id, total_amount, reinvestment_amount,
              data_fees_amount, random_amount, status, approved_by, created_at, completed_at
       FROM autobot_distrib.distribution_rounds
       WHERE period_month = $1::date`,
      [monthStr]
    );

    if (!roundResult.rows[0]) return null;

    const round = roundResult.rows[0];

    // Transaction summary
    const txnResult = await query(
      `SELECT
         transaction_type,
         status,
         COUNT(*) as count,
         COALESCE(SUM(amount), 0) as total_amount
       FROM autobot_distrib.distribution_transactions
       WHERE round_id = $1
       GROUP BY transaction_type, status
       ORDER BY transaction_type, status`,
      [round.id]
    );

    return {
      roundId: round.id,
      periodMonth: round.period_month,
      allocationId: round.allocation_id,
      totalAmount: parseFloat(round.total_amount),
      reinvestmentAmount: parseFloat(round.reinvestment_amount),
      dataFeesAmount: parseFloat(round.data_fees_amount),
      randomAmount: parseFloat(round.random_amount),
      status: round.status,
      approvedBy: round.approved_by,
      createdAt: round.created_at,
      completedAt: round.completed_at,
      transactions: txnResult.rows.map(r => ({
        transactionType: r.transaction_type,
        status: r.status,
        count: parseInt(r.count),
        totalAmount: parseFloat(r.total_amount),
      })),
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) return null;
    throw err;
  }
}

/**
 * Get recent distribution history for dashboard display.
 *
 * @returns {Array} Recent rounds with summary data
 */
export async function getDistributionHistory() {
  try {
    const result = await query(
      `SELECT
         dr.id, dr.period_month, dr.total_amount, dr.reinvestment_amount,
         dr.data_fees_amount, dr.random_amount, dr.status, dr.approved_by,
         dr.created_at, dr.completed_at,
         (SELECT COUNT(*) FROM autobot_distrib.distribution_transactions dt WHERE dt.round_id = dr.id) as transaction_count,
         (SELECT COUNT(*) FROM autobot_distrib.distribution_transactions dt WHERE dt.round_id = dr.id AND dt.status = 'confirmed') as confirmed_count
       FROM autobot_distrib.distribution_rounds dr
       ORDER BY dr.period_month DESC
       LIMIT 12`
    );

    return result.rows.map(r => ({
      roundId: r.id,
      periodMonth: r.period_month,
      totalAmount: parseFloat(r.total_amount),
      reinvestmentAmount: parseFloat(r.reinvestment_amount),
      dataFeesAmount: parseFloat(r.data_fees_amount),
      randomAmount: parseFloat(r.random_amount),
      status: r.status,
      approvedBy: r.approved_by,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      transactionCount: parseInt(r.transaction_count),
      confirmedCount: parseInt(r.confirmed_count),
    }));
  } catch (err) {
    if (err.message?.includes('does not exist')) return [];
    throw err;
  }
}
