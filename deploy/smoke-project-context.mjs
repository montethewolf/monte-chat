#!/usr/bin/env node
// Real realtime-provider check of restored project context; no Hermes dispatch.
import WebSocket from 'ws';
import { HermesLiveClient } from 'hermes-live-voice/browser';
import { applyManagedConfigToProcess } from '../node_modules/hermes-live-voice/dist/cli/managed-config.js';
import { loadConfig } from '../node_modules/hermes-live-voice/dist/config.js';
await applyManagedConfigToProcess(); const c = loadConfig();
const client = new HermesLiveClient({ url: `ws://127.0.0.1:${c.server.port}/v1/live`, discussionId: `catalog_probe_${Date.now()}`,
  webSocketFactory: url => new WebSocket(url, { headers: { Authorization: `Bearer ${c.server.authToken}` } }) });
let output = '', done = false, bytes = 0, active = false, connected = false; const failures = [];
client.on('session.error', e => failures.push(e.code));
client.on('transcript.delta', e => { if (active && e.speaker === 'assistant') output = e.final ? e.text : output + e.text; });
client.on('audio.output', e => { if (active) bytes += Buffer.from(e.data, 'base64').length; });
client.on('response.completed', () => { if (active && /factory/i.test(output) && /lng/i.test(output)) done = true; });
client.on('task.accepted', () => { if (active) failures.push('unexpected Hermes dispatch'); });
try {
  await client.connect({ conversation: { mode: 'new', title: `Monte catalog check ${Date.now()}` } });
  connected = true;
  client.reportPlayback(false, false); active = true;
  client.sendText('From the project catalog already in your context, briefly name the available projects and identify which GitHub repository Monte Factory processes. This is a context check; do not delegate a task.');
  const started = performance.now();
  while (!done && !failures.length && performance.now() - started < 30000) await new Promise(r => setTimeout(r, 100));
  if (!done || failures.length || !bytes || !/monte.chat/i.test(output)) throw new Error(`Project context check failed: ${failures.join(', ')}; ${output.slice(0, 500)}`);
  console.log(JSON.stringify({ passed: true, durationMs: Math.round(performance.now() - started), pcmBytes: bytes, answer: output.trim() }));
} finally { const closing = client.disconnect('Project catalog check finished'); if (connected) await closing; else await closing.catch(() => {}); }
