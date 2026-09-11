#!/usr/bin/env node
// Read-only real Hermes preflight. No credentials or issue bodies are printed.
import { randomUUID } from 'node:crypto';
import { applyManagedConfigToProcess } from '../node_modules/hermes-live-voice/dist/cli/managed-config.js';
import { loadConfig } from '../node_modules/hermes-live-voice/dist/config.js';
import { HermesClient } from '../node_modules/hermes-live-voice/dist/adapters/outbound/hermes/hermes-runs.client.js';
await applyManagedConfigToProcess();
const config = loadConfig(), hermes = new HermesClient(config.hermes);
await hermes.assertRunsSupported();
const sessionKey = `monte-preflight:${randomUUID()}`;
const startedAt = performance.now();
const started = await hermes.startRun({ sessionId: sessionKey, sessionKey,
  instructions: 'Read-only integration preflight. Use normal tools. Do not write files, post messages or make changes. Return only the requested short verification.',
  input: 'Using the terminal tool, inspect GitHub issues 74 and 76 in wabansia/lng-gg with gh issue view (only number/title/state), then run /home/alex/Development/monte-factory/bin/factoryq output 74 classify. Return a short statement confirming which lookups succeeded and the actionable field from the factory result. Do not ask the user for identifiers; they are specified here. Do not print credentials.' });
console.log(JSON.stringify({ accepted: true, runId: started.runId, backend: config.hermes.baseUrl }));
let finished = false;
try {
  while (performance.now() - startedAt < 180000) {
    const result = await hermes.getRun(started.runId, { sessionKey });
    if (result.status === 'completed') {
      if (!/74/.test(result.output) || !/76/.test(result.output) || !/actionable/i.test(result.output)) throw new Error('Hermes did not confirm all three requested lookups');
      finished = true;
      console.log(JSON.stringify({ passed: true, durationMs: Math.round(performance.now() - startedAt), result: result.output.slice(0, 1400) }));
      break;
    }
    if (['failed', 'cancelled', 'waiting_for_approval'].includes(result.status)) throw new Error(`Preflight needs inspection: ${result.status}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!finished) throw new Error('Normal Hermes preflight timed out');
} finally {
  if (!finished) await hermes.stopRun(started.runId, { sessionKey }).catch(() => {});
}
