/**
 * Smart Deploy Client for Project Campaigns
 *
 * Detects framework and routes deploys to the optimal platform:
 * - Next.js, Nuxt, SvelteKit, Astro, static → Vercel (edge, ISR, free tier)
 * - Express, Fastify, plain Node, Python → Railway (process-based)
 *
 * Auth via RAILWAY_TOKEN / VERCEL_TOKEN env vars (P2 — never in LLM prompts).
 * Graceful degradation: if tokens are missing, campaign continues without deploy.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { query } from '../../lib/db.js';
import { fetchWithTimeout } from '../../lib/runtime/fetch-utils.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'project-deploy' });

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

/**
 * Execute a Railway GraphQL query/mutation.
 * @param {string} queryStr - GraphQL query string
 * @param {Object} variables - Query variables
 * @returns {Promise<Object>} Response data
 */
async function railwayGql(queryStr, variables = {}) {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) throw new Error('RAILWAY_TOKEN not configured');

  const res = await fetchWithTimeout(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: queryStr, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Railway API error (${res.status}): ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Railway GraphQL error: ${json.errors[0].message}`);
  }
  return json.data;
}

/**
 * Create a Railway project.
 * @param {string} name - Project name
 * @returns {Promise<string>} Railway project ID
 */
export async function createRailwayProject(name) {
  const data = await railwayGql(
    `mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id }
    }`,
    { input: { name } }
  );
  return data.projectCreate.id;
}

/**
 * Create a Railway service linked to a GitHub repo.
 * @param {string} projectId - Railway project ID
 * @param {string} repoFullName - GitHub repo (e.g., "staqsIO/my-project")
 * @returns {Promise<string>} Railway service ID
 */
export async function createRailwayService(projectId, repoFullName) {
  const data = await railwayGql(
    `mutation($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id }
    }`,
    { input: { projectId, source: { repo: repoFullName } } }
  );
  return data.serviceCreate.id;
}

/**
 * Poll until deployment succeeds or timeout.
 * @param {string} serviceId - Railway service ID
 * @param {number} [timeoutMs=300000] - Max wait time (default 5 min)
 * @returns {Promise<string>} Deployment status
 */
export async function waitForDeploy(serviceId, timeoutMs = 300_000) {
  const start = Date.now();
  const pollIntervalMs = 10_000;

  while (Date.now() - start < timeoutMs) {
    const data = await railwayGql(
      `query($serviceId: String!) {
        deployments(first: 1, input: { serviceId: $serviceId }) {
          edges { node { id status } }
        }
      }`,
      { serviceId }
    );

    const deployment = data.deployments?.edges?.[0]?.node;
    if (!deployment) {
      await sleep(pollIntervalMs);
      continue;
    }

    if (deployment.status === 'SUCCESS') return 'SUCCESS';
    if (deployment.status === 'FAILED' || deployment.status === 'CRASHED') {
      throw new Error(`Railway deployment ${deployment.status}`);
    }

    // Still deploying — wait and poll again
    await sleep(pollIntervalMs);
  }

  throw new Error(`Railway deployment timed out after ${timeoutMs / 1000}s`);
}

/**
 * Get the public URL for a Railway service.
 * @param {string} serviceId - Railway service ID
 * @returns {Promise<string|null>} Public URL or null
 */
export async function getServiceUrl(serviceId) {
  const data = await railwayGql(
    `query($serviceId: String!) {
      service(id: $serviceId) {
        serviceInstances {
          edges {
            node {
              domains { serviceDomains { domain } }
            }
          }
        }
      }
    }`,
    { serviceId }
  );

  const instances = data.service?.serviceInstances?.edges || [];
  for (const edge of instances) {
    const domains = edge.node?.domains?.serviceDomains || [];
    if (domains.length > 0) {
      return `https://${domains[0].domain}`;
    }
  }
  return null;
}

/**
 * Delete a Railway project (cleanup).
 * @param {string} projectId - Railway project ID
 */
export async function deleteRailwayProject(projectId) {
  await railwayGql(
    `mutation($id: String!) {
      projectDelete(id: $id)
    }`,
    { id: projectId }
  );
}

// ============================================================
// Framework Detection
// ============================================================

/**
 * Detect the framework from the workspace to choose the optimal deploy target.
 * @param {string} workspacePath - Path to the project workspace
 * @returns {Promise<{framework: string, provider: 'vercel'|'railway'}>}
 */
export async function detectFramework(workspacePath) {
  try {
    const pkgPath = join(workspacePath, 'package.json');
    const raw = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (allDeps['next']) return { framework: 'nextjs', provider: 'vercel' };
    if (allDeps['nuxt'] || allDeps['nuxt3']) return { framework: 'nuxt', provider: 'vercel' };
    if (allDeps['@sveltejs/kit']) return { framework: 'sveltekit', provider: 'vercel' };
    if (allDeps['astro']) return { framework: 'astro', provider: 'vercel' };
    if (allDeps['gatsby']) return { framework: 'gatsby', provider: 'vercel' };
    if (allDeps['vite'] && !allDeps['express']) return { framework: 'vite', provider: 'vercel' };
    if (allDeps['express'] || allDeps['fastify'] || allDeps['koa'] || allDeps['hono']) return { framework: 'node-server', provider: 'railway' };

    // Default Node.js project → Railway
    return { framework: 'node', provider: 'railway' };
  } catch {
    // No package.json → check for static HTML
    try {
      await readFile(join(workspacePath, 'index.html'), 'utf-8');
      return { framework: 'static', provider: 'vercel' };
    } catch {
      return { framework: 'unknown', provider: 'railway' };
    }
  }
}

// ============================================================
// Vercel Deploy
// ============================================================

const VERCEL_API = 'https://api.vercel.com';

/**
 * Deploy a GitHub repo to Vercel.
 * @param {string} campaignId - Campaign ID
 * @param {string} repoFullName - GitHub repo (e.g., "staqsIO/my-project")
 * @param {string} framework - Detected framework name
 * @returns {Promise<string|null>} Preview URL or null
 */
export async function deployToVercel(campaignId, repoFullName, framework) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    log.warn(` VERCEL_TOKEN not set — falling back to Railway`);
    return null;
  }

  const teamId = process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID || '';
  const teamParam = teamId ? `?teamId=${teamId}` : '';

  try {
    log.info(` Deploying ${repoFullName} to Vercel (${framework})...`);

    // Step 1: Create Vercel project linked to GitHub repo
    const [owner, repo] = repoFullName.split('/');
    const createRes = await fetchWithTimeout(`${VERCEL_API}/v10/projects${teamParam}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: repo,
        framework: framework === 'nextjs' ? 'nextjs' : framework === 'nuxt' ? 'nuxtjs' : framework === 'sveltekit' ? 'sveltekit' : framework === 'astro' ? 'astro' : framework === 'gatsby' ? 'gatsby' : null,
        gitRepository: {
          type: 'github',
          repo: repoFullName,
        },
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Vercel project creation failed (${createRes.status}): ${err}`);
    }

    const project = await createRes.json();
    const projectId = project.id;
    const projectName = project.name;
    log.info(`   Vercel project: ${projectName} (${projectId})`);

    // Step 2: Trigger deployment (Vercel auto-deploys from GitHub, but ensure it)
    const deployRes = await fetchWithTimeout(`${VERCEL_API}/v13/deployments${teamParam}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: projectName,
        project: projectId,
        gitSource: {
          type: 'github',
          org: owner,
          repo,
          ref: 'main',
        },
      }),
    });

    if (!deployRes.ok) {
      // Vercel may auto-deploy — check for existing deployment
      log.warn(`   Deploy trigger returned ${deployRes.status} — checking for auto-deploy`);
    } else {
      log.info(`   Deploy triggered`);
    }

    // Step 3: Wait for deployment
    const deployResult = await waitForVercelDeploy(projectName, token, teamParam);

    // Step 4: Store in campaign metadata (including errors for iteration feedback)
    await query(
      `UPDATE agent_graph.campaigns
       SET metadata = COALESCE(metadata, '{}'::jsonb)
         || jsonb_build_object(
              'preview_url', COALESCE($1::text, ''),
              'deploy_provider', 'vercel',
              'deploy_error', COALESCE($5::text, ''),
              'vercel_project_id', $2::text,
              'vercel_project_name', $3::text
            ),
         updated_at = now()
       WHERE id = $4`,
      [deployResult.url || '', projectId, projectName, campaignId, deployResult.error || '']
    );

    if (deployResult.error) {
      log.error(`   Build failed: ${deployResult.error.slice(0, 200)}`);
      // Return error object so caller can feed it back to the iteration loop
      return { url: null, error: deployResult.error, buildLog: deployResult.buildLog };
    }

    log.info(`   Preview URL: ${deployResult.url}`);
    return { url: deployResult.url, error: null };
  } catch (err) {
    log.error(` Vercel deploy failed: ${err.message}`);
    return { url: null, error: err.message };
  }
}

/**
 * Poll Vercel for deployment completion.
 */
/**
 * Poll Vercel for deployment completion. Returns { url, error, buildLog }.
 * - url: set when deploy succeeds
 * - error: set when deploy fails (build error, crash, etc.)
 * - buildLog: Vercel build output for error diagnosis
 */
async function waitForVercelDeploy(projectName, token, teamParam, timeoutMs = 180_000) {
  const start = Date.now();
  const pollIntervalMs = 10_000;

  while (Date.now() - start < timeoutMs) {
    try {
      // Query ALL recent deployments (not just READY) so we can detect failures
      const res = await fetchWithTimeout(
        `${VERCEL_API}/v6/deployments?projectId=${projectName}&limit=1${teamParam ? '&' + teamParam.slice(1) : ''}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        const deployment = data.deployments?.[0];
        if (!deployment) { await sleep(pollIntervalMs); continue; }

        if (deployment.state === 'READY') {
          return { url: `https://${deployment.url}`, error: null, buildLog: null };
        }

        if (deployment.state === 'ERROR' || deployment.state === 'CANCELED') {
          // Fetch build logs for error diagnosis
          let buildLog = '';
          try {
            const logRes = await fetchWithTimeout(
              `${VERCEL_API}/v2/deployments/${deployment.uid}/events${teamParam}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (logRes.ok) {
              const events = await logRes.json();
              buildLog = events
                .filter(e => e.type === 'stdout' || e.type === 'stderr')
                .map(e => e.payload?.text || e.text || '')
                .join('\n')
                .slice(-2000); // Last 2K chars of build output
            }
          } catch { /* non-critical */ }

          return {
            url: null,
            error: `Vercel build ${deployment.state}: ${buildLog.slice(-200) || 'no details'}`,
            buildLog,
          };
        }

        // Still building — continue polling
      }
    } catch { /* retry */ }
    await sleep(pollIntervalMs);
  }
  return { url: null, error: 'Deploy timed out', buildLog: null };
}

/**
 * Delete a Vercel project (cleanup).
 * @param {string} projectId - Vercel project ID
 */
export async function deleteVercelProject(projectId) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return;
  const teamId = process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID || '';
  const teamParam = teamId ? `?teamId=${teamId}` : '';

  await fetchWithTimeout(`${VERCEL_API}/v9/projects/${projectId}${teamParam}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ============================================================
// Smart Deploy Orchestrator
// ============================================================

/**
 * Full deploy orchestrator: detect framework, route to Vercel or Railway,
 * create project, wait for deploy, get URL. Stores preview URL and
 * provider info in campaign metadata.
 *
 * @param {string} campaignId - Campaign ID
 * @param {string} repoFullName - GitHub repo (e.g., "staqsIO/my-project")
 * @param {string} [workspacePath] - Local workspace path for framework detection
 * @returns {Promise<{url: string|null, error: string|null, buildLog: string|null}>}
 */
export async function deployProject(campaignId, repoFullName, workspacePath) {
  // Detect framework to choose optimal deploy target
  const { framework, provider } = workspacePath
    ? await detectFramework(workspacePath)
    : { framework: 'unknown', provider: 'railway' };

  log.info(` Detected framework: ${framework} → ${provider} for campaign ${campaignId}`);

  // Route to Vercel for frontend frameworks
  if (provider === 'vercel') {
    const result = await deployToVercel(campaignId, repoFullName, framework);
    if (result?.url) return result; // Success
    if (result?.error) {
      // Build failed — do NOT fall back to Railway. Return error so campaign can fix the code.
      log.error(` Vercel build failed — returning error for iteration feedback (not falling back to Railway)`);
      return result;
    }
    // Only fall back to Railway if Vercel is truly unavailable (no token, API down)
    if (!process.env.VERCEL_TOKEN) {
      log.info(` Vercel unavailable (no token) — falling back to Railway`);
    } else {
      // Vercel returned null without error — shouldn't happen, but don't fall back on ambiguity
      return { url: null, error: 'Vercel deploy returned no result', buildLog: null };
    }
  }

  // Railway path (backend frameworks only — frontend build errors should NOT land here)
  if (!process.env.RAILWAY_TOKEN) {
    log.warn(` No deploy tokens configured — skipping deploy for campaign ${campaignId}`);
    return { url: null, error: 'No deploy tokens configured', buildLog: null };
  }

  try {
    log.info(` Deploying ${repoFullName} to Railway...`);

    const slug = repoFullName.split('/').pop() || campaignId.slice(0, 8);
    const projectId = await createRailwayProject(`optimus-${slug}`);
    log.info(`   Railway project: ${projectId}`);

    const serviceId = await createRailwayService(projectId, repoFullName);
    log.info(`   Railway service: ${serviceId}`);

    await waitForDeploy(serviceId);
    log.info(`   Deploy succeeded`);

    const previewUrl = await getServiceUrl(serviceId);
    log.info(`   Preview URL: ${previewUrl || '(no domain yet)'}`);

    await query(
      `UPDATE agent_graph.campaigns
       SET metadata = COALESCE(metadata, '{}'::jsonb)
         || jsonb_build_object(
              'preview_url', $1::text,
              'deploy_provider', 'railway',
              'railway_project_id', $2::text,
              'railway_service_id', $3::text
            ),
         updated_at = now()
       WHERE id = $4`,
      [previewUrl || '', projectId, serviceId, campaignId]
    );

    return { url: previewUrl, error: null, buildLog: null };
  } catch (err) {
    log.error(` Deploy failed for campaign ${campaignId}: ${err.message}`);
    return { url: null, error: err.message, buildLog: null };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
