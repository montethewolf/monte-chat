#!/usr/bin/env node
// One bounded read-only consultation, sent only to the isolated research profile.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HermesClient } from '../node_modules/hermes-live-voice/dist/adapters/outbound/hermes/hermes-runs.client.js';
const home = join(homedir(), '.hermes-research');
const env = Object.fromEntries((await readFile(join(home, 'gateway.env'), 'utf8')).trim().split('\n').map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
const registry = JSON.parse(await readFile(env.HERMES_LIVE_REPOSITORY_REGISTRY, 'utf8'));
const project = registry.projects.find(p => p.name === 'monte-chat');
if (!project) throw new Error('Monte Chat is not registered');
const backend = new HermesClient({ baseUrl: env.HERMES_LIVE_RESEARCH_URL, apiKey: env.HERMES_LIVE_RESEARCH_API_KEY });
await backend.assertRunsSupported();
const startedAt = Date.now();
const receipt = await backend.startRun({ sessionId: `monte-research-preflight-${startedAt}`, sessionKey: 'monte-research-preflight',
  instructions: 'Read-only preflight. Use only repository tools. Return one sentence with a file reference and the HLV dependency version. Do not propose or perform work.',
  input: `Use repo_read to read package.json in registered project ${project.id}. What is the hermes-live-voice dependency?` });
console.log(JSON.stringify({ accepted: true, runId: receipt.runId }));
for (;;) {
  const state = await backend.getRun(receipt.runId, { sessionKey: 'monte-research-preflight' });
  if (state.status === 'completed') { console.log(JSON.stringify({ passed: true, elapsedMs: Date.now() - startedAt, output: state.output.slice(0, 1200) })); break; }
  if (['failed', 'cancelled', 'waiting_for_approval'].includes(state.status)) throw new Error(`Restricted research preflight ${state.status}: ${state.error ?? ''}`);
  if (Date.now() - startedAt > 180000) { await backend.stopRun(receipt.runId, { sessionKey: 'monte-research-preflight' }); throw new Error('Research preflight timed out and cancellation was requested'); }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
