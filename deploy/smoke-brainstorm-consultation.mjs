#!/usr/bin/env node
// Real voice-model -> gateway -> normal Hermes consultation, in an isolated discussion.
import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
import { HermesLiveClient } from 'hermes-live-voice/browser';
import { applyManagedConfigToProcess } from '../node_modules/hermes-live-voice/dist/cli/managed-config.js';
import { loadConfig } from '../node_modules/hermes-live-voice/dist/config.js';
await applyManagedConfigToProcess(); const c = loadConfig();
const discussionId = `consult_probe_${Date.now()}`;
const client = new HermesLiveClient({ url: `ws://127.0.0.1:${c.server.port}/v1/live`, discussionId,
  webSocketFactory: url => new WebSocket(url, { headers: { Authorization: `Bearer ${c.server.authToken}` } }) });
let connected = false, reply = '', audioBytes = 0, receipt, completed = false, findingsSpoken = false; const failures = [];
client.on('session.error', e => failures.push(e.code));
client.on('transcript.delta', e => { if (e.speaker === 'assistant') reply = e.final ? e.text : reply + e.text; });
client.on('audio.output', e => { audioBytes += Buffer.from(e.data, 'base64').length; });
client.on('response.completed', () => {
  if (/\b74\b/.test(reply) && /(?:not actionable|actionable[^.]{0,40}false|false[^.]{0,40}actionable)/i.test(reply)) findingsSpoken = true;
});
const started = performance.now();
try {
  const ready = await client.connect({ conversation: { mode: 'new', title: `Monte consultation check ${Date.now()}` } }); connected = true;
  if (ready.interactionMode !== 'brainstorm') throw new Error('This preflight requires Brainstorm already selected; it does not change the user preference.');
  client.reportPlayback(false, false);
  client.sendText('Read-only check: find the Factory item about keeping sessions in ending until persistence succeeds. Tell me its issue number and whether Factory classified it as actionable. I do not remember the project name; use the available project context and investigate with Hermes. Do not change anything.');
  while (performance.now() - started < 150000) {
    if (failures.length) throw new Error(failures.join(', '));
    const state = JSON.parse(await readFile(c.tasks.stateFile, 'utf8'));
    const task = state.tasks.find(t => t.purpose === 'consultation' && t.research?.discussionId === discussionId);
    if (task) {
      if (!receipt) { receipt = task.taskId; console.log(JSON.stringify({ receipt, backend: task.backend, selectedProjectFromContext: Boolean(task.research.project), acceptedMs: Math.round(performance.now() - started) })); }
      if (task.backend !== 'work') throw new Error('Consultation used the restricted backend');
      if (['failed', 'cancelled'].includes(task.status)) throw new Error(`Consultation ${task.status}`);
      if (task.status === 'completed' && findingsSpoken && audioBytes > 0) { completed = true; break; }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!completed) throw new Error(`Consultation did not reach spoken findings: ${reply.slice(-1000)}`);
  console.log(JSON.stringify({ passed: true, receipt, durationMs: Math.round(performance.now() - started), audioBytes, reply: reply.slice(-1800) }));
} finally { const closing = client.disconnect('Brainstorm consultation check finished'); if (connected) await closing; else await closing.catch(() => {}); }
