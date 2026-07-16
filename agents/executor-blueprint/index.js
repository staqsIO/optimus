import { AgentLoop } from '../../lib/runtime/agent-loop.js';
import { query } from '../../lib/db.js';
import { fetchWithTimeout } from '../../lib/runtime/fetch-utils.js';
import { createHash } from 'crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { requirePermission, logCapabilityInvocation } from '../../lib/runtime/permissions.js';
import { publishEvent } from '../../lib/runtime/infrastructure.js';
import { runExecutor } from '../../lib/runtime/executor-adapter.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'executor-blueprint' });

/**
 * Executor-Blueprint agent: 4 specialist analyses → synthesis → HTML blueprint.
 *
 * Runs on Jamie M1. Polls for blueprint work items, claims them atomically,
 * runs 4 parallel specialist passes (Liotta, Linus, Delphi, Cost Model),
 * synthesizes into a self-contained HTML document, and emails the result.
 *
 * Pipeline:
 *   1. Extract brief from work item metadata
 *   2. Run 4 specialist passes in parallel via Promise.all
 *   3. Synthesis pass: merge all analyses into unified blueprint
 *   4. Generate self-contained HTML document
 *   5. Store html_output in work item metadata
 *   6. Send email notification (if notify_email set)
 *
 * Gates: G1 (budget), G6 (rate limiting in API layer)
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = join(__dirname, '..', '..', 'data', 'blueprints');
const CLI_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per specialist pass
const SYNTHESIS_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes for synthesis + HTML
const DB_KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * Strip <script> tags from HTML for output safety.
 * Preserves JSON-LD structured data scripts.
 */
function stripScripts(html) {
  return html.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*<\/script>/gi, (match) => {
    if (/type\s*=\s*["']application\/ld\+json["']/i.test(match)) {
      return match;
    }
    return '';
  });
}

/**
 * Keep-alive ping to prevent DB pool connections from going stale during
 * long CLI operations. Returns a stop function.
 */
function startDbKeepalive() {
  const timer = setInterval(async () => {
    try {
      await query('SELECT 1');
    } catch (err) {
      log.warn(` DB keepalive ping failed: ${err.message}`);
    }
  }, DB_KEEPALIVE_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Query with retry — for critical writes that must not be lost.
 */
async function queryWithRetry(text, params, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await query(text, params);
    } catch (err) {
      log.warn(` DB query attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

/**
 * Write the project brief file that all specialist passes read.
 */
function writeBrief(jobDir, metadata) {
  const lines = [
    '# Project Blueprint Brief\n',
    '## Project Description',
    metadata.blueprint_description,
    '',
    '## Target Audience',
    metadata.audience || 'Not specified',
    '',
    '## Budget',
    metadata.budget || 'Not specified',
    '',
    '## Timeline',
    metadata.timeline || 'Not specified',
    '',
    '## Has Existing Spec/PRD',
    metadata.has_spec ? 'Yes' : 'No',
    '',
  ];

  if (metadata.site_url) {
    lines.push('## Existing Site URL', metadata.site_url, '');
  }

  writeFileSync(join(jobDir, 'brief.md'), lines.join('\n'));
}

/**
 * Specialist pass: Liotta — Architecture & Approach
 */
function runLiotta({ workDir, maxBudgetUsd, model }) {
  return runExecutor({
    prompt: `You are analyzing a project for a technical blueprint. Read ./brief.md for the full project description.

Produce a thorough architecture analysis covering:

1. **Recommended Tech Stack** — specific technologies, frameworks, and services with reasoning for each choice
2. **System Design** — high-level architecture diagram (describe in text), service boundaries, data flow
3. **Scalability Considerations** — what needs to scale, when, and how
4. **Build vs Buy Decisions** — what to build custom vs use existing services/APIs
5. **API Design** — key endpoints, data models, authentication approach
6. **Infrastructure** — hosting, CI/CD, monitoring, environments
7. **Key Technical Decisions** — the 3-5 decisions that will most impact the project

Be specific and opinionated. Reference the project description directly. No generic advice.

Write your analysis to ./liotta.md`,
    systemPrompt: 'You are Liotta, a contrarian systems architect. Find the simplest architecture that solves the problem. Favor boring infrastructure over novel tech. Be specific — name exact technologies, services, and patterns. Every recommendation must tie back to the project requirements.',
    workDir,
    maxBudgetUsd,
    model: model || 'sonnet',
    allowedTools: ['Read', 'Write'],
    maxTurns: 15,
    timeoutMs: CLI_TIMEOUT_MS,
    label: 'liotta',
    agentTag: 'executor-blueprint',
  });
}

/**
 * Specialist pass: Linus — Risk Assessment
 */
function runLinus({ workDir, maxBudgetUsd, model }) {
  return runExecutor({
    prompt: `You are assessing risks for a software project. Read ./brief.md for the full project description.

Produce a thorough risk assessment covering:

1. **Complexity Traps** — features that seem simple but hide significant complexity
2. **Security Considerations** — authentication, data handling, common vulnerability patterns
3. **Technical Debt Risk** — shortcuts that will cost 10x later, architecture decisions that lock you in
4. **Dependency Risks** — third-party services, APIs, or libraries that could become problems
5. **Scope Creep Vectors** — where requirements are vague enough to explode
6. **What Could Go Wrong** — the 5 most likely failure modes and their mitigations
7. **Integration Risks** — external systems, data migration, API compatibility

For each risk, rate severity (Critical/High/Medium/Low) and provide a specific mitigation strategy.

Write your analysis to ./linus.md`,
    systemPrompt: 'You are Linus, a brutally honest risk assessor. Your job is to find what will go wrong before it does. Be specific about risks — cite exact features, integrations, and architectural choices from the brief. No hand-waving. Every risk must have a concrete mitigation.',
    workDir,
    maxBudgetUsd,
    allowedTools: ['Read', 'Write'],
    maxTurns: 15,
    timeoutMs: CLI_TIMEOUT_MS,
    model: model || 'sonnet',
    label: 'linus',
    agentTag: 'executor-blueprint',
  });
}

/**
 * Specialist pass: Delphi — User Experience
 */
function runDelphi({ workDir, maxBudgetUsd, model }) {
  return runExecutor({
    prompt: `You are analyzing the user experience for a software project. Read ./brief.md for the full project description.

Produce a thorough UX analysis covering:

1. **User Flows** — map the critical user journeys (onboarding, core action, conversion)
2. **UI Patterns** — recommend specific interface patterns (navigation, forms, dashboards, etc.)
3. **Accessibility** — WCAG 2.2 AA requirements, screen reader considerations, keyboard navigation
4. **Mobile Considerations** — responsive design strategy, mobile-first vs desktop-first, touch targets
5. **Onboarding Experience** — first-run experience, progressive disclosure, time-to-value
6. **Information Architecture** — content hierarchy, navigation structure, search/filter patterns
7. **Interaction Design** — loading states, error handling, empty states, micro-interactions

Be specific to this project. Reference the target audience and use case directly.

Write your analysis to ./delphi.md`,
    systemPrompt: 'You are Delphi, a UX design evaluator. Focus on what makes users successful, not what looks pretty. Every recommendation should reduce friction or increase clarity. Reference the specific audience and use case from the brief.',
    workDir,
    maxBudgetUsd,
    allowedTools: ['Read', 'Write'],
    maxTurns: 15,
    timeoutMs: CLI_TIMEOUT_MS,
    model: model || 'sonnet',
    label: 'delphi',
    agentTag: 'executor-blueprint',
  });
}

/**
 * Specialist pass: Cost Model — Budget & Timeline
 */
function runCostModel({ workDir, maxBudgetUsd, model }) {
  return runExecutor({
    prompt: `You are creating a cost and timeline estimate for a software project. Read ./brief.md for the full project description.

Produce a thorough cost and timeline analysis covering:

1. **Development Cost Breakdown** — by feature/component, with hour estimates and rate assumptions
2. **Timeline Phases** — discovery, MVP, v1.0, with milestones and deliverables per phase
3. **Resource Requirements** — team composition (roles, seniority), full-time vs contractors
4. **Infrastructure Costs** — monthly hosting, services, APIs, tools (with specific pricing)
5. **MVP Scope** — what to build first, what to defer, and why (include a "cut list")
6. **Ongoing Costs** — maintenance, monitoring, support, scaling costs at different user volumes
7. **Cost Risks** — where estimates are most uncertain and what could blow the budget

Provide three tiers: Lean MVP, Standard Build, Full Vision. For each tier, give total cost range and timeline.

Write your analysis to ./cost-model.md`,
    systemPrompt: 'You are a pragmatic technical project estimator. Give honest cost and timeline ranges, not optimistic fantasies. When estimates are uncertain, say so and explain why. Reference specific technologies and services with real pricing. The client needs to make budget decisions — be precise enough to be useful.',
    workDir,
    maxBudgetUsd,
    allowedTools: ['Read', 'Write'],
    maxTurns: 15,
    timeoutMs: CLI_TIMEOUT_MS,
    model: model || 'sonnet',
    label: 'cost-model',
    agentTag: 'executor-blueprint',
  });
}

/**
 * Synthesis pass: merge all specialist analyses into a self-contained HTML blueprint.
 */
function synthesizeBlueprint({ workDir, maxBudgetUsd, model }) {
  return runExecutor({
    prompt: `You are synthesizing 4 specialist analyses into a unified project blueprint document.

Read these files:
1. ./brief.md — the original project description
2. ./liotta.md — architecture & approach analysis
3. ./linus.md — risk assessment
4. ./delphi.md — user experience analysis
5. ./cost-model.md — budget & timeline analysis

Produce a SINGLE self-contained HTML file at ./blueprint.html that presents the complete blueprint.

## HTML Requirements
- Self-contained: ALL CSS inline in <style> tags
- Use Google Fonts via <link> tags (only external resource allowed)
- Mobile-responsive (CSS Grid/Flexbox, media queries)
- No external CSS files or JS frameworks
- No <script> tags

## Design System (STAQS.IO brand)
- Dark theme: background #0f1923, card backgrounds #1a2332, borders #2a3a4a
- Primary accent: #22c55e (green)
- Secondary accent: #3b82f6 (blue)
- Text: #e2e8f0 (primary), #94a3b8 (secondary), #64748b (muted)
- Font: 'Inter' for body, 'JetBrains Mono' for code/technical content
- Monospace terminal aesthetic with clean, professional layout
- Border radius: 8px on cards, 4px on buttons
- Card shadows: 0 4px 6px -1px rgba(0,0,0,0.3)

## Document Structure
1. **Header** — STAQS.IO branding, project name, generation date
2. **Executive Summary** — 3-5 bullet synthesis of the key findings across all analyses
3. **Architecture & Approach** (from Liotta) — tech stack, system design, key decisions
4. **Risk Assessment** (from Linus) — top risks with severity ratings and mitigations
5. **UX Strategy** (from Delphi) — user flows, UI patterns, accessibility, mobile
6. **Cost & Timeline** (from Cost Model) — three tiers, development phases, infrastructure costs
7. **Recommended Next Steps** — prioritized action items synthesized from all analyses
8. **Footer** — "Blueprint generated by STAQS.IO agents" + generation timestamp

## Synthesis Rules
- Cross-reference between sections: if Linus flags a risk about a technology Liotta recommends, note it
- Resolve conflicts: if specialists disagree, present both views with your recommendation
- The executive summary should highlight the MOST important findings, not just summarize each section
- Extract a "project name" from the description and use it as the document title
- Include a table of contents with anchor links

Write the final file to ./blueprint.html
Also write ./project-name.txt containing ONLY the extracted project name (one line, no quotes).`,
    systemPrompt: `You are a senior technical consultant producing a client-deliverable project blueprint. The document must be:
1. Visually polished — dark theme, STAQS.IO brand, terminal aesthetic
2. Substantive — every section has specific, actionable content (not generic filler)
3. Cross-referenced — findings from one analysis inform others
4. Decision-ready — the reader should be able to make go/no-go and prioritization decisions from this document
Produce ./blueprint.html and ./project-name.txt. Do not ask questions — synthesize the best blueprint you can.`,
    workDir,
    maxBudgetUsd,
    model: model || 'sonnet',
    allowedTools: ['Read', 'Write', 'Glob'],
    maxTurns: 25,
    timeoutMs: SYNTHESIS_TIMEOUT_MS,
    label: 'synthesis',
    agentTag: 'executor-blueprint',
  });
}

/**
 * Escape HTML special characters for safe embedding in templates.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send blueprint completion email via Resend API.
 */
async function sendBlueprintEmail(to, projectName, jobId) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');

  const previewUrl = `https://staqs.io/api/blueprint/view/${jobId}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0f1923;font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="color:#22c55e !important;font-size:28px;letter-spacing:4px;margin:0;font-weight:700;"><a href="https://staqs.io" style="color:#22c55e !important;text-decoration:none !important;">STAQS<span style="display:none;"> </span>.IO</a></h1>
      <p style="color:#64748b !important;font-size:11px;letter-spacing:3px;margin:4px 0 0;text-transform:uppercase;">Agentic Engineering Studio</p>
    </div>

    <!-- Terminal window -->
    <div style="background-color:#1a2332;border:1px solid #2a3a4a;border-radius:8px;overflow:hidden;">

      <!-- Title bar -->
      <div style="background-color:#152029;padding:10px 16px;display:flex;align-items:center;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#ef4444;margin-right:6px;"></span>
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#eab308;margin-right:6px;"></span>
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e;margin-right:6px;"></span>
        <span style="color:#64748b;font-size:12px;margin-left:8px;">staqs@terminal ~ %</span>
      </div>

      <!-- Content -->
      <div style="padding:24px;">
        <p style="color:#22c55e;margin:0 0 4px;font-size:14px;">$ staqs blueprint --complete</p>
        <p style="color:#64748b;margin:0 0 20px;font-size:12px;">// blueprint analysis finished</p>

        <p style="color:#e2e8f0;margin:0 0 6px;font-size:14px;"><span style="color:#22c55e;">[=========]</span> Done!</p>
        <p style="color:#e2e8f0;margin:0 0 20px;font-size:13px;">
          <span style="color:#22c55e;">&#10022;</span> Your blueprint for <span style="color:#22c55e;">${escapeHtml(projectName || 'your project')}</span> is ready.
        </p>

        <!-- CTA Button -->
        <div style="text-align:center;margin:28px 0;">
          <a href="${previewUrl}" style="display:inline-block;background-color:#22c55e;color:#0f1923;padding:14px 32px;text-decoration:none;font-weight:700;font-size:14px;border-radius:4px;letter-spacing:1px;">VIEW YOUR BLUEPRINT &rarr;</a>
        </div>

        <p style="color:#64748b;margin:20px 0 4px;font-size:12px;">// shareable link (yours to keep):</p>
        <p style="margin:0 0 20px;font-size:12px;"><a href="${previewUrl}" style="color:#22c55e;text-decoration:underline;">${previewUrl}</a></p>

        <div style="border-top:1px solid #2a3a4a;padding-top:16px;margin-top:16px;">
          <p style="color:#64748b;margin:0 0 4px;font-size:12px;">// what just happened:</p>
          <p style="color:#94a3b8;margin:0;font-size:12px;line-height:1.8;">
            &gt; Liotta analyzed architecture &amp; tech stack<br>
            &gt; Linus assessed risks &amp; failure modes<br>
            &gt; Delphi mapped user experience &amp; accessibility<br>
            &gt; Cost Model estimated budget &amp; timeline<br>
            &gt; Synthesized into a unified project blueprint
          </p>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div style="text-align:center;margin-top:32px;">
      <p style="color:#64748b;font-size:12px;margin:0 0 8px;">Four specialist agents analyzed your project. Ready to build?</p>
      <p style="margin:0 0 16px;"><a href="mailto:hello@staqs.io" style="color:#22c55e;font-size:14px;text-decoration:none;font-weight:600;">hello@staqs.io &rarr;</a></p>
      <p style="color:#475569;font-size:11px;margin:0;">
        <a href="https://staqs.io" style="color:#475569;text-decoration:none;">staqs.io</a>
        &nbsp;&middot;&nbsp;
        <a href="https://github.com/staqsIO" style="color:#475569;text-decoration:none;">GitHub</a>
        &nbsp;&middot;&nbsp;
        <a href="https://linkedin.com/company/staqs" style="color:#475569;text-decoration:none;">LinkedIn</a>
      </p>
    </div>

  </div>
</body>
</html>`;

  const textVersion = `Your blueprint for ${projectName || 'your project'} is ready!

View it here: ${previewUrl}

What happened:
- Liotta analyzed architecture & tech stack
- Linus assessed risks & failure modes
- Delphi mapped user experience & accessibility
- Cost Model estimated budget & timeline
- Synthesized into a unified project blueprint

Ready to build? hello@staqs.io — https://staqs.io`;

  const res = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'STAQS.IO <hello@staqs.io>',
      to: [to],
      subject: `Your STAQS.IO Blueprint is Ready — ${projectName || 'Project Blueprint'}`,
      html,
      text: textVersion,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
}

/**
 * Main handler: extract brief → 4 specialist passes → synthesis → store + email.
 */
async function handler(task, context, agent) {
  const metadata = context.workItem?.metadata || {};
  const description = metadata.blueprint_description;

  if (!description) {
    return { success: false, reason: 'No blueprint_description in work item metadata' };
  }

  const jobDir = join(WORK_DIR, task.work_item_id);
  mkdirSync(jobDir, { recursive: true });

  const costBreakdown = { specialists: 0, synthesis: 0, total: 0 };
  let stopKeepalive = null;

  try {
    // ── Step 1: Write brief ──────────────────────────────────────
    log.info(` Writing brief for job ${task.work_item_id}`);
    writeBrief(jobDir, metadata);

    // ── Step 2: Start DB keepalive ───────────────────────────────
    stopKeepalive = startDbKeepalive();

    // ── Step 3: Run 4 specialist passes in parallel ──────────────
    const claudeCodeConfig = agent.config?.claudeCode || {};
    const perPassBudget = (claudeCodeConfig.maxBudgetUsd || 5.00) / 5; // ~$1 each, $1 for synthesis
    const cliModel = claudeCodeConfig.model || 'sonnet';

    log.info(` Running 4 specialist passes in parallel (budget: $${perPassBudget.toFixed(2)}/pass, model: ${cliModel})`);
    const specialistStartMs = Date.now();

    await requirePermission(agent.agentId, 'subprocess', 'claude_cli');

    // RC4: Stagger specialists in pairs to avoid grabbing all 4 Claude CLI slots at once.
    // Max 2 concurrent Claude sessions per batch, leaving slots for redesign reviews.
    const [liottaResult, linusResult] = await Promise.all([
      runLiotta({ workDir: jobDir, maxBudgetUsd: perPassBudget, model: cliModel }),
      runLinus({ workDir: jobDir, maxBudgetUsd: perPassBudget, model: cliModel }),
    ]);
    const [delphiResult, costModelResult] = await Promise.all([
      runDelphi({ workDir: jobDir, maxBudgetUsd: perPassBudget, model: cliModel }),
      runCostModel({ workDir: jobDir, maxBudgetUsd: perPassBudget, model: cliModel }),
    ]);

    const specialistDurationMs = Date.now() - specialistStartMs;

    logCapabilityInvocation({
      agentId: agent.agentId, resourceType: 'subprocess', resourceName: 'claude_cli',
      success: true, durationMs: specialistDurationMs,
      workItemId: task.work_item_id,
      resultSummary: `4 specialist passes in ${Math.round(specialistDurationMs / 1000)}s`,
    });

    // Log results
    const results = [
      { name: 'Liotta', result: liottaResult, file: 'liotta.md' },
      { name: 'Linus', result: linusResult, file: 'linus.md' },
      { name: 'Delphi', result: delphiResult, file: 'delphi.md' },
      { name: 'Cost Model', result: costModelResult, file: 'cost-model.md' },
    ];

    let failedPasses = 0;
    for (const { name, result, file } of results) {
      const ok = !result.error && !result.isError;
      const produced = existsSync(join(jobDir, file));
      costBreakdown.specialists += result.costUsd || 0;

      if (!ok || !produced) {
        failedPasses++;
        log.error(` ${name}: FAILED — ${result.error || 'no output file'}`);
      } else {
        log.info(` ${name}: OK (${result.numTurns} turns, $${(result.costUsd || 0).toFixed(4)})`);
      }
    }

    log.info(` Specialist passes complete in ${Math.round(specialistDurationMs / 1000)}s (${failedPasses} failed)`);

    // Need at least 2 of 4 passes to produce a useful blueprint
    if (failedPasses > 2) {
      return { success: false, reason: `Too many specialist passes failed (${failedPasses}/4). Cannot produce blueprint.` };
    }

    // ── Step 4: Synthesis pass ───────────────────────────────────
    log.info(` Running synthesis pass`);
    const synthesisResult = await synthesizeBlueprint({
      workDir: jobDir,
      maxBudgetUsd: perPassBudget,
      model: cliModel,
    });

    costBreakdown.synthesis = synthesisResult.costUsd || 0;

    if (synthesisResult.error || synthesisResult.isError) {
      log.error(` Synthesis failed: ${synthesisResult.error || 'CLI error'}`);
      return { success: false, reason: `Synthesis failed: ${(synthesisResult.error || 'CLI error').slice(0, 200)}` };
    }

    log.info(` Synthesis complete (${synthesisResult.numTurns} turns, $${(synthesisResult.costUsd || 0).toFixed(4)})`);

    // ── Step 5: Read and process output ──────────────────────────
    if (!existsSync(join(jobDir, 'blueprint.html'))) {
      return { success: false, reason: 'Synthesis did not produce blueprint.html' };
    }

    let blueprintHtml = readFileSync(join(jobDir, 'blueprint.html'), 'utf-8');
    blueprintHtml = stripScripts(blueprintHtml);

    // Extract project name
    let projectName = null;
    try {
      if (existsSync(join(jobDir, 'project-name.txt'))) {
        projectName = readFileSync(join(jobDir, 'project-name.txt'), 'utf-8').trim();
      }
    } catch (err) {
      log.warn(` Failed to read project-name.txt: ${err.message}`);
    }

    if (!projectName) {
      // Fallback: extract from description
      projectName = description.slice(0, 60).replace(/[^\w\s-]/g, '').trim();
    }

    costBreakdown.total = costBreakdown.specialists + costBreakdown.synthesis;

    // ── Step 6: Store in Postgres ────────────────────────────────
    stopKeepalive();
    stopKeepalive = null;

    log.info(` Storing blueprint in work_item metadata`);

    // Read specialist analyses for metadata storage
    const specialistAnalyses = {};
    for (const { name, file } of results) {
      try {
        if (existsSync(join(jobDir, file))) {
          specialistAnalyses[name.toLowerCase().replace(/\s+/g, '_')] = readFileSync(join(jobDir, file), 'utf-8');
        }
      } catch (err) {
        log.warn(` Failed to read ${file}: ${err.message}`);
      }
    }

    await queryWithRetry(
      `UPDATE agent_graph.work_items
       SET metadata = metadata || $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          html_output: blueprintHtml,
          project_name: projectName,
          cost_usd: costBreakdown.total,
          specialist_analyses: specialistAnalyses,
        }),
        task.work_item_id,
      ]
    );

    // Log to llm_invocations for audit trail (P3)
    try {
      const promptHash = createHash('sha256').update(description).digest('hex');
      const responseHash = createHash('sha256').update(blueprintHtml.slice(0, 1000)).digest('hex');
      const idempotencyKey = `blueprint-gen-${task.work_item_id}-${promptHash.slice(0, 16)}`;

      await queryWithRetry(
        `INSERT INTO agent_graph.llm_invocations
         (agent_id, task_id, model, input_tokens, output_tokens, cost_usd,
          prompt_hash, response_hash, latency_ms, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          agent.agentId, task.work_item_id, 'claude-sonnet-4-6',
          0, 0, costBreakdown.total,
          promptHash, responseHash, 0, idempotencyKey,
        ]
      );
    } catch (err) {
      log.warn(` Failed to log to llm_invocations: ${err.message}`);
    }

    await publishEvent(
      'blueprint_completed',
      `Blueprint completed: ${projectName}`,
      agent.agentId, task.work_item_id,
      { project_name: projectName, cost_usd: costBreakdown.total }
    );

    log.info(` Blueprint complete: "${projectName}" (cost: $${costBreakdown.total.toFixed(4)})`);

    // ── Step 7: Send email notification ──────────────────────────
    // ADR-017: permission check + audit for api_client:resend_email
    const notifyEmail = metadata.notify_email || metadata.requester_email;
    if (notifyEmail) {
      const emailStartMs = Date.now();
      let emailSuccess = false;
      try {
        await requirePermission(agent.agentId, 'api_client', 'resend_email');
        await sendBlueprintEmail(notifyEmail, projectName, task.work_item_id);
        emailSuccess = true;
        log.info(` Notification email sent to ${notifyEmail}`);
      } catch (emailErr) {
        log.warn(` Failed to send notification email: ${emailErr.message}`);
      } finally {
        logCapabilityInvocation({
          agentId: agent.agentId, resourceType: 'api_client', resourceName: 'resend_email',
          success: emailSuccess, durationMs: Date.now() - emailStartMs,
          errorMessage: emailSuccess ? null : 'failed or denied',
          workItemId: task.work_item_id,
        });
      }
    }

    return {
      success: true,
      reason: `Blueprint completed: "${projectName}" (cost: $${costBreakdown.total.toFixed(4)})`,
      costUsd: costBreakdown.total,
    };
  } finally {
    try { stopKeepalive?.(); } catch {}
    // Cleanup work directory
    try {
      const { rm } = await import('fs/promises');
      await rm(jobDir, { recursive: true, force: true });
    } catch {}
  }
}

export const blueprintLoop = new AgentLoop('executor-blueprint', handler);
