import { query } from '../db.js';

/**
 * Value Measurement Script — One of 5 Immutable Components (spec S13, Law 1)
 * NO AI. Deterministic only.
 *
 * Law 1: "Net positive value — every product must deliver more value than it costs."
 *
 * Tracks:
 * - User retention as a proxy for value delivered
 * - Revenue per user vs cost per user
 * - Value ratio = (revenue - cost) / cost — must be positive
 * - Product-level and aggregate tracking
 *
 * Agents have SELECT only access on output tables.
 */

/**
 * Compute daily product value metrics for a given product and date.
 *
 * Aggregates active_users, new_users, churned_users, retained_users,
 * retention_rate, revenue, cost, value_ratio, and net_value from
 * product_metrics records already stored for prior days.
 *
 * Inserts or updates a single product_metrics row for the given date.
 *
 * @param {string} productId
 * @param {string|Date} date - ISO date string or Date object
 * @returns {object|null} The computed metrics row, or null if schema not ready
 */
export async function measureProductValue(productId, date) {
  const dateStr = formatDate(date);

  try {
    // Fetch the previous day's metrics for retained-user baseline
    const prevResult = await query(
      `SELECT active_users FROM autobot_value.product_metrics
       WHERE product_id = $1 AND measurement_date = ($2::date - interval '1 day')::date
       ORDER BY created_at DESC LIMIT 1`,
      [productId, dateStr]
    );
    const prevActiveUsers = prevResult.rows[0]?.active_users ?? 0;

    // Fetch today's raw metrics if already recorded (allows re-computation)
    const existingResult = await query(
      `SELECT * FROM autobot_value.product_metrics
       WHERE product_id = $1 AND measurement_date = $2::date
       ORDER BY created_at DESC LIMIT 1`,
      [productId, dateStr]
    );

    const existing = existingResult.rows[0];

    // Use existing raw counts if present, otherwise default to 0
    const activeUsers = existing ? parseInt(existing.active_users) : 0;
    const newUsers = existing ? parseInt(existing.new_users) : 0;
    const churnedUsers = existing ? parseInt(existing.churned_users) : 0;
    const revenue = existing ? parseFloat(existing.revenue) : 0;
    const cost = existing ? parseFloat(existing.cost) : 0;

    // Compute derived metrics
    const retainedUsers = prevActiveUsers > 0
      ? activeUsers - newUsers
      : activeUsers;
    const retentionRate = prevActiveUsers > 0
      ? Math.min(retainedUsers / prevActiveUsers, 1.0)
      : null;
    const valueRatio = cost > 0
      ? (revenue - cost) / cost
      : null;
    const netValue = revenue - cost;

    // Upsert the computed metrics row
    if (existing) {
      await query(
        `UPDATE autobot_value.product_metrics SET
           retained_users = $1,
           retention_rate = $2,
           value_ratio = $3,
           net_value = $4
         WHERE id = $5`,
        [retainedUsers, retentionRate, valueRatio, netValue, existing.id]
      );
    } else {
      await query(
        `INSERT INTO autobot_value.product_metrics
         (product_id, measurement_date, active_users, new_users, churned_users,
          retained_users, retention_rate, revenue, cost, value_ratio, net_value)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [productId, dateStr, activeUsers, newUsers, churnedUsers,
         retainedUsers, retentionRate, revenue, cost, valueRatio, netValue]
      );
    }

    // Return the final computed row
    const finalResult = await query(
      `SELECT * FROM autobot_value.product_metrics
       WHERE product_id = $1 AND measurement_date = $2::date
       ORDER BY created_at DESC LIMIT 1`,
      [productId, dateStr]
    );

    return finalResult.rows[0] || null;
  } catch (err) {
    if (err.message?.includes('does not exist')) return null;
    throw err;
  }
}

/**
 * Compute an aggregate value assessment over a period.
 *
 * Aggregates retention_rate, revenue, cost, and value_ratio across all
 * product_metrics rows in the given period. Determines Law 1 compliance
 * and produces a recommendation based on value_ratio thresholds.
 *
 * Thresholds:
 *   value_ratio > 0.5  -> continue
 *   value_ratio > 0    -> optimize
 *   value_ratio > -0.2 -> sunset
 *   else               -> discontinue
 *
 * @param {string} productId
 * @param {string} assessmentType - 'daily' | 'weekly' | 'monthly' | 'quarterly'
 * @param {string|Date} periodStart
 * @param {string|Date} periodEnd
 * @returns {object|null} The assessment row, or null if schema not ready
 */
export async function computeValueAssessment(productId, assessmentType, periodStart, periodEnd) {
  const startStr = formatDate(periodStart);
  const endStr = formatDate(periodEnd);

  try {
    // Aggregate metrics across the period
    const metricsResult = await query(
      `SELECT
         AVG(retention_rate) AS avg_retention,
         COALESCE(SUM(revenue), 0) AS total_revenue,
         COALESCE(SUM(cost), 0) AS total_cost
       FROM autobot_value.product_metrics
       WHERE product_id = $1
         AND measurement_date >= $2::date
         AND measurement_date <= $3::date`,
      [productId, startStr, endStr]
    );

    const row = metricsResult.rows[0];
    const aggregateRetention = row.avg_retention !== null
      ? parseFloat(row.avg_retention)
      : null;
    const totalRevenue = parseFloat(row.total_revenue);
    const totalCost = parseFloat(row.total_cost);

    // Value ratio = (revenue - cost) / cost
    const aggregateValueRatio = totalCost > 0
      ? (totalRevenue - totalCost) / totalCost
      : null;

    // Law 1: net positive value
    const netPositive = totalRevenue > totalCost;
    const law1Compliant = aggregateValueRatio !== null && aggregateValueRatio > 0;

    // Recommendation based on value ratio thresholds
    let recommendation;
    let rationale;
    if (aggregateValueRatio === null) {
      recommendation = 'optimize';
      rationale = 'Insufficient cost data to compute value ratio; defaulting to optimize.';
    } else if (aggregateValueRatio > 0.5) {
      recommendation = 'continue';
      rationale = `Value ratio ${aggregateValueRatio.toFixed(4)} exceeds 0.5 threshold. Product is delivering strong net positive value.`;
    } else if (aggregateValueRatio > 0) {
      recommendation = 'optimize';
      rationale = `Value ratio ${aggregateValueRatio.toFixed(4)} is positive but below 0.5. Product delivers value but has room for improvement.`;
    } else if (aggregateValueRatio > -0.2) {
      recommendation = 'sunset';
      rationale = `Value ratio ${aggregateValueRatio.toFixed(4)} is between -0.2 and 0. Product is marginally net negative — consider sunsetting.`;
    } else {
      recommendation = 'discontinue';
      rationale = `Value ratio ${aggregateValueRatio.toFixed(4)} is below -0.2. Product is significantly net negative — recommend discontinuation.`;
    }

    // Insert the assessment
    const insertResult = await query(
      `INSERT INTO autobot_value.value_assessments
       (product_id, assessment_type, period_start, period_end,
        aggregate_retention, aggregate_value_ratio, total_revenue, total_cost,
        net_positive, law1_compliant, recommendation, rationale)
       VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [productId, assessmentType, startStr, endStr,
       aggregateRetention, aggregateValueRatio, totalRevenue, totalCost,
       netPositive, law1Compliant, recommendation, rationale]
    );

    return insertResult.rows[0] || null;
  } catch (err) {
    if (err.message?.includes('does not exist')) return null;
    throw err;
  }
}

/**
 * Compute or update cohort retention for a given product and cohort month.
 *
 * Counts retained users at 1, 2, 3, 6, and 12 month intervals by comparing
 * active_users at each subsequent month to the cohort's initial_users.
 *
 * @param {string} productId
 * @param {string|Date} cohortMonth - First day of the cohort month
 * @returns {object|null} The cohort row, or null if schema not ready
 */
export async function computeCohortRetention(productId, cohortMonth) {
  const monthStr = formatMonth(cohortMonth);

  try {
    // Get initial users for the cohort month
    const initialResult = await query(
      `SELECT COALESCE(SUM(new_users), 0) AS initial_users
       FROM autobot_value.product_metrics
       WHERE product_id = $1
         AND measurement_date >= $2::date
         AND measurement_date < ($2::date + interval '1 month')::date`,
      [productId, monthStr]
    );

    const initialUsers = parseInt(initialResult.rows[0]?.initial_users ?? 0);
    if (initialUsers === 0) return null;

    // Compute retention at each interval by looking at active users in those months
    const retentionMonths = [1, 2, 3, 6, 12];
    const retentionValues = {};

    for (const m of retentionMonths) {
      const retResult = await query(
        `SELECT AVG(active_users) AS avg_active
         FROM autobot_value.product_metrics
         WHERE product_id = $1
           AND measurement_date >= ($2::date + ($3::int || ' months')::interval)::date
           AND measurement_date < ($2::date + (($3::int + 1) || ' months')::interval)::date`,
        [productId, monthStr, m]
      );
      const avgActive = retResult.rows[0]?.avg_active;
      retentionValues[`retained_month_${m}`] = avgActive !== null
        ? Math.round(parseFloat(avgActive))
        : null;
    }

    // Check for existing cohort row
    const existingResult = await query(
      `SELECT id FROM autobot_value.user_cohorts
       WHERE product_id = $1 AND cohort_month = $2::date
       LIMIT 1`,
      [productId, monthStr]
    );

    if (existingResult.rows[0]) {
      await query(
        `UPDATE autobot_value.user_cohorts SET
           initial_users = $1,
           retained_month_1 = $2,
           retained_month_2 = $3,
           retained_month_3 = $4,
           retained_month_6 = $5,
           retained_month_12 = $6
         WHERE id = $7`,
        [initialUsers,
         retentionValues.retained_month_1,
         retentionValues.retained_month_2,
         retentionValues.retained_month_3,
         retentionValues.retained_month_6,
         retentionValues.retained_month_12,
         existingResult.rows[0].id]
      );
    } else {
      await query(
        `INSERT INTO autobot_value.user_cohorts
         (product_id, cohort_month, initial_users,
          retained_month_1, retained_month_2, retained_month_3,
          retained_month_6, retained_month_12)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)`,
        [productId, monthStr, initialUsers,
         retentionValues.retained_month_1,
         retentionValues.retained_month_2,
         retentionValues.retained_month_3,
         retentionValues.retained_month_6,
         retentionValues.retained_month_12]
      );
    }

    // Return the final row
    const finalResult = await query(
      `SELECT * FROM autobot_value.user_cohorts
       WHERE product_id = $1 AND cohort_month = $2::date
       ORDER BY created_at DESC LIMIT 1`,
      [productId, monthStr]
    );

    return finalResult.rows[0] || null;
  } catch (err) {
    if (err.message?.includes('does not exist')) return null;
    throw err;
  }
}

/**
 * Get a dashboard view of all product value assessments.
 *
 * Returns the latest assessment for each active product, plus aggregate
 * totals across the entire portfolio.
 *
 * @returns {object|null} Dashboard data, or null if schema not ready
 */
export async function getValueDashboard() {
  try {
    // Get all active products with their latest assessment
    const productsResult = await query(
      `SELECT p.id, p.name, p.status, p.launched_at,
              va.assessment_type, va.period_start, va.period_end,
              va.aggregate_retention, va.aggregate_value_ratio,
              va.total_revenue, va.total_cost,
              va.net_positive, va.law1_compliant,
              va.recommendation, va.rationale, va.created_at AS assessed_at
       FROM autobot_value.products p
       LEFT JOIN LATERAL (
         SELECT * FROM autobot_value.value_assessments
         WHERE product_id = p.id
         ORDER BY created_at DESC LIMIT 1
       ) va ON true
       WHERE p.status = 'active'
       ORDER BY p.name`
    );

    // Compute portfolio aggregate
    const aggregateResult = await query(
      `SELECT
         COUNT(DISTINCT product_id) AS product_count,
         AVG(aggregate_retention) AS avg_retention,
         SUM(total_revenue) AS total_revenue,
         SUM(total_cost) AS total_cost
       FROM autobot_value.value_assessments va
       WHERE va.id IN (
         SELECT DISTINCT ON (product_id) id
         FROM autobot_value.value_assessments
         ORDER BY product_id, created_at DESC
       )`
    );

    const agg = aggregateResult.rows[0];
    const portfolioRevenue = parseFloat(agg?.total_revenue ?? 0);
    const portfolioCost = parseFloat(agg?.total_cost ?? 0);
    const portfolioValueRatio = portfolioCost > 0
      ? (portfolioRevenue - portfolioCost) / portfolioCost
      : null;

    return {
      products: productsResult.rows.map(r => ({
        id: r.id,
        name: r.name,
        status: r.status,
        launchedAt: r.launched_at,
        latestAssessment: r.assessment_type ? {
          type: r.assessment_type,
          periodStart: r.period_start,
          periodEnd: r.period_end,
          retention: r.aggregate_retention !== null ? parseFloat(r.aggregate_retention) : null,
          valueRatio: r.aggregate_value_ratio !== null ? parseFloat(r.aggregate_value_ratio) : null,
          revenue: parseFloat(r.total_revenue ?? 0),
          cost: parseFloat(r.total_cost ?? 0),
          netPositive: r.net_positive,
          law1Compliant: r.law1_compliant,
          recommendation: r.recommendation,
          rationale: r.rationale,
          assessedAt: r.assessed_at,
        } : null,
      })),
      portfolio: {
        productCount: parseInt(agg?.product_count ?? 0),
        avgRetention: agg?.avg_retention !== null ? parseFloat(agg.avg_retention) : null,
        totalRevenue: portfolioRevenue,
        totalCost: portfolioCost,
        valueRatio: portfolioValueRatio,
        law1Compliant: portfolioValueRatio !== null && portfolioValueRatio > 0,
      },
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) return null;
    throw err;
  }
}

/**
 * Check Law 1 compliance across all active products.
 *
 * Law 1: "Net positive value — every product must deliver more value than it costs."
 * A product is Law 1 compliant if its latest assessment has value_ratio > 0.
 *
 * @returns {object|null} Compliance report, or null if schema not ready
 */
export async function checkLaw1Compliance() {
  try {
    const result = await query(
      `SELECT p.id, p.name, p.status,
              va.aggregate_value_ratio, va.law1_compliant, va.recommendation,
              va.total_revenue, va.total_cost,
              va.created_at AS assessed_at
       FROM autobot_value.products p
       LEFT JOIN LATERAL (
         SELECT * FROM autobot_value.value_assessments
         WHERE product_id = p.id
         ORDER BY created_at DESC LIMIT 1
       ) va ON true
       WHERE p.status = 'active'
       ORDER BY va.aggregate_value_ratio ASC NULLS FIRST`
    );

    const products = result.rows.map(r => ({
      id: r.id,
      name: r.name,
      valueRatio: r.aggregate_value_ratio !== null ? parseFloat(r.aggregate_value_ratio) : null,
      law1Compliant: r.law1_compliant ?? false,
      recommendation: r.recommendation,
      revenue: parseFloat(r.total_revenue ?? 0),
      cost: parseFloat(r.total_cost ?? 0),
      assessedAt: r.assessed_at,
    }));

    const compliant = products.filter(p => p.law1Compliant);
    const nonCompliant = products.filter(p => !p.law1Compliant);

    return {
      allCompliant: nonCompliant.length === 0 && products.length > 0,
      totalProducts: products.length,
      compliantCount: compliant.length,
      nonCompliantCount: nonCompliant.length,
      compliant,
      nonCompliant,
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) return null;
    throw err;
  }
}

/**
 * Get the health summary for a specific product.
 *
 * Returns the latest daily metrics and latest assessment.
 *
 * @param {string} productId
 * @returns {object|null} Product health data, or null if schema not ready / product not found
 */
export async function getProductHealth(productId) {
  try {
    // Get product info
    const productResult = await query(
      `SELECT * FROM autobot_value.products WHERE id = $1`,
      [productId]
    );

    if (productResult.rows.length === 0) return null;

    const product = productResult.rows[0];

    // Get latest daily metrics
    const metricsResult = await query(
      `SELECT * FROM autobot_value.product_metrics
       WHERE product_id = $1
       ORDER BY measurement_date DESC
       LIMIT 7`,
      [productId]
    );

    // Get latest assessment
    const assessmentResult = await query(
      `SELECT * FROM autobot_value.value_assessments
       WHERE product_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [productId]
    );

    // Get latest cohort data
    const cohortResult = await query(
      `SELECT * FROM autobot_value.user_cohorts
       WHERE product_id = $1
       ORDER BY cohort_month DESC
       LIMIT 3`,
      [productId]
    );

    const latestMetrics = metricsResult.rows[0] || null;
    const latestAssessment = assessmentResult.rows[0] || null;

    return {
      product: {
        id: product.id,
        name: product.name,
        status: product.status,
        launchedAt: product.launched_at,
      },
      latestMetrics: latestMetrics ? {
        date: latestMetrics.measurement_date,
        activeUsers: parseInt(latestMetrics.active_users),
        newUsers: parseInt(latestMetrics.new_users),
        churnedUsers: parseInt(latestMetrics.churned_users),
        retainedUsers: parseInt(latestMetrics.retained_users),
        retentionRate: latestMetrics.retention_rate !== null ? parseFloat(latestMetrics.retention_rate) : null,
        revenue: parseFloat(latestMetrics.revenue),
        cost: parseFloat(latestMetrics.cost),
        valueRatio: latestMetrics.value_ratio !== null ? parseFloat(latestMetrics.value_ratio) : null,
        netValue: parseFloat(latestMetrics.net_value),
      } : null,
      recentMetrics: metricsResult.rows.map(r => ({
        date: r.measurement_date,
        activeUsers: parseInt(r.active_users),
        retentionRate: r.retention_rate !== null ? parseFloat(r.retention_rate) : null,
        valueRatio: r.value_ratio !== null ? parseFloat(r.value_ratio) : null,
        netValue: parseFloat(r.net_value),
      })),
      latestAssessment: latestAssessment ? {
        type: latestAssessment.assessment_type,
        periodStart: latestAssessment.period_start,
        periodEnd: latestAssessment.period_end,
        retention: latestAssessment.aggregate_retention !== null ? parseFloat(latestAssessment.aggregate_retention) : null,
        valueRatio: latestAssessment.aggregate_value_ratio !== null ? parseFloat(latestAssessment.aggregate_value_ratio) : null,
        revenue: parseFloat(latestAssessment.total_revenue),
        cost: parseFloat(latestAssessment.total_cost),
        netPositive: latestAssessment.net_positive,
        law1Compliant: latestAssessment.law1_compliant,
        recommendation: latestAssessment.recommendation,
        rationale: latestAssessment.rationale,
        assessedAt: latestAssessment.created_at,
      } : null,
      cohorts: cohortResult.rows.map(r => ({
        cohortMonth: r.cohort_month,
        initialUsers: parseInt(r.initial_users),
        retainedMonth1: r.retained_month_1 !== null ? parseInt(r.retained_month_1) : null,
        retainedMonth2: r.retained_month_2 !== null ? parseInt(r.retained_month_2) : null,
        retainedMonth3: r.retained_month_3 !== null ? parseInt(r.retained_month_3) : null,
        retainedMonth6: r.retained_month_6 !== null ? parseInt(r.retained_month_6) : null,
        retainedMonth12: r.retained_month_12 !== null ? parseInt(r.retained_month_12) : null,
      })),
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) return null;
    throw err;
  }
}

// ============================================================
// Helpers
// ============================================================

function formatDate(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    return date.slice(0, 10);
  }
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function formatMonth(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    return date.slice(0, 7) + '-01';
  }
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
