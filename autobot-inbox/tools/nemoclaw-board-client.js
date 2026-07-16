/**
 * NemoClaw Board API Client — thin HTTP wrapper for Optimus interaction.
 *
 * Runs inside the NemoClaw sandbox. Token passed as argument (never stored on disk).
 * Token is injected via host environment variable, read at runtime.
 *
 * Usage:
 *   import { createClient } from './nemoclaw-board-client.js';
 *   const client = createClient(process.env.OPTIMUS_TOKEN, 'https://preview.staqs.io');
 *   const health = await client.getHealth();
 *   await client.createWorkItem({ type: 'task', title: 'Fix bug', assignedTo: 'executor-coder' });
 */

async function request(token, apiUrl, method, path, body = null) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${apiUrl}${path}`, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.error || `API error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function createClient(token, apiUrl = 'https://preview.staqs.io') {
  if (!token) throw new Error('OPTIMUS_TOKEN required');

  return {
    // Pipeline
    getHealth: () => request(token, apiUrl, 'GET', '/api/pipeline/health'),

    // Work items
    createWorkItem: ({ type = 'task', title, description, assignedTo, priority, metadata }) =>
      request(token, apiUrl, 'POST', '/api/campaigns', {
        type, title, description, assigned_to: assignedTo, priority, metadata,
      }),

    listWorkItems: (filters = {}) => {
      const params = new URLSearchParams(filters).toString();
      return request(token, apiUrl, 'GET', `/api/runs?${params}`);
    },

    // Proposals (drafts, PRs, tickets)
    getProposals: (filters = {}) => {
      const params = new URLSearchParams(filters).toString();
      return request(token, apiUrl, 'GET', `/api/drafts?${params}`);
    },

    approveProposal: (id) =>
      request(token, apiUrl, 'POST', '/api/drafts/approve', { id }),

    rejectProposal: (id, feedback) =>
      request(token, apiUrl, 'POST', '/api/drafts/reject', { id, feedback }),

    // Agent status
    getAgentStatus: () => request(token, apiUrl, 'GET', '/api/agents/status'),

    // Intents
    getIntents: () => request(token, apiUrl, 'GET', '/api/intents'),

    approveIntent: (id) =>
      request(token, apiUrl, 'POST', `/api/intents/${id}/approve`, {}),

    rejectIntent: (id, feedback) =>
      request(token, apiUrl, 'POST', `/api/intents/${id}/reject`, { feedback }),
  };
}

// CLI mode: run directly for quick testing
if (process.argv[1]?.endsWith('nemoclaw-board-client.js') && process.argv[2]) {
  const token = process.env.OPTIMUS_TOKEN;
  const apiUrl = process.env.OPTIMUS_API_URL || 'https://preview.staqs.io';
  if (!token) { console.error('Set OPTIMUS_TOKEN env var'); process.exit(1); }

  const client = createClient(token, apiUrl);
  const cmd = process.argv[2];

  try {
    if (cmd === 'health') console.log(JSON.stringify(await client.getHealth(), null, 2));
    else if (cmd === 'status') console.log(JSON.stringify(await client.getAgentStatus(), null, 2));
    else if (cmd === 'intents') console.log(JSON.stringify(await client.getIntents(), null, 2));
    else if (cmd === 'drafts') console.log(JSON.stringify(await client.getProposals(), null, 2));
    else console.error(`Unknown command: ${cmd}. Try: health, status, intents, drafts`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
