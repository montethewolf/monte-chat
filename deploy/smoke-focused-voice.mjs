#!/usr/bin/env node
// Resume the selected Hermes history, then optionally exercise PCM input/output.
// The probe has its own discussion notes and requests only local mode inspection.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { HermesLiveClient } from 'hermes-live-voice/browser';
import { applyManagedConfigToProcess } from '../node_modules/hermes-live-voice/dist/cli/managed-config.js';
import { loadConfig } from '../node_modules/hermes-live-voice/dist/config.js';

await applyManagedConfigToProcess();
const config = loadConfig();
const selection = JSON.parse(await readFile(process.env.HLV_STATE_FILE ?? join(homedir(), '.local/state/hlv-discord/state.json'), 'utf8'));
const sessionId = process.env.HLV_PROBE_SESSION_ID ?? selection.focus?.sessionId ?? selection.defaultSessionId;
if (!sessionId) throw new Error('No saved session is available for a resume check');
const client = new HermesLiveClient({ url: `ws://127.0.0.1:${config.server.port}/v1/live`,
  discussionId: `diagnostic_${Date.now()}`, connectTimeoutMs: 15000,
  webSocketFactory: url => new WebSocket(url, { headers: config.server.authToken ? { Authorization: `Bearer ${config.server.authToken}` } : {} }) });
let bytes = 0, firstAudioAt, audioEndedAt, completion = false, spokenText = '', inputText = '';
let checkStarted = false, resumed = false, expectedMode = '';
const failures = [];
client.on('session.error', event => failures.push(`${event.code}: ${event.message}`));
client.on('audio.output', event => {
  if (!checkStarted) return;
  firstAudioAt ??= performance.now();
  bytes += Buffer.from(event.data, 'base64').length;
});
client.on('transcript.delta', event => {
  if (!checkStarted) return;
  if (event.speaker === 'user') inputText = event.final ? event.text : inputText + event.text;
  else spokenText = event.final ? event.text : spokenText + event.text;
});
client.on('response.completed', () => { if (checkStarted && bytes > 0 && expectedMode && spokenText.toLowerCase().includes(expectedMode)) completion = true; });
client.on('task.accepted', () => { if (checkStarted) failures.push('Unexpected background task acceptance'); });
try {
  const started = performance.now();
  const ready = await client.connect({ conversation: { mode: 'resume', sessionId } });
  resumed = true;
  const state = await client.setMode();
  expectedMode = state.interactionMode;
  console.log(JSON.stringify({ connected: true, focused: Boolean(selection.focus), resumedSession: ready.conversation.sessionId, protocolVersion: ready.protocolVersion,
    mode: state.interactionMode, resumeMs: Math.round(performance.now() - started) }));
  if (process.argv.includes('--audio')) {
    const voice = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'flite=text=What conversation mode are we in? Please inspect the current mode and answer briefly.:voice=slt',
      '-ar', '24000', '-ac', '1', '-f', 's16le', 'pipe:1'], { maxBuffer: 2_000_000 });
    const pcm = Buffer.concat([Buffer.alloc(9600), voice, Buffer.alloc(24000)]);
    checkStarted = true;
    client.reportPlayback(false, true);
    for (let offset = 0; offset < pcm.length; offset += 4800) {
      client.sendAudio(pcm.subarray(offset, offset + 4800).toString('base64'), 'audio/pcm;rate=24000');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    audioEndedAt = performance.now();
    client.endAudio();
    client.reportPlayback(false, false);
    const deadline = performance.now() + 30000;
    while (!completion && !failures.length && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (!completion || !bytes || !/mode/i.test(inputText)) throw new Error(`Audio check incomplete: ${JSON.stringify({ bytes, completion, inputRecognized: /mode/i.test(inputText), failures })}`);
    console.log(JSON.stringify({ audioPassed: true, pcmBytes: bytes, firstAudioMs: Math.round(firstAudioAt - audioEndedAt),
      inputRecognized: true, modeAnswerVerified: spokenText.toLowerCase().includes(expectedMode), reply: spokenText.slice(0, 500) }));
  }
  if (failures.length) throw new Error(failures.join('; '));
} finally {
  const closing = client.disconnect('Focused voice preflight finished');
  if (resumed) await closing;
  else await closing.catch(() => {}); // Preserve the original startup error.
}
