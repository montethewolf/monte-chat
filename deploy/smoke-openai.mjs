#!/usr/bin/env node
// Uses the configured OpenAI adapter; no speech, user turn, or Hermes work is requested.
import { applyManagedConfigToProcess } from '../node_modules/hermes-live-voice/dist/cli/managed-config.js';
import { loadConfig } from '../node_modules/hermes-live-voice/dist/config.js';
import { OpenAIRealtimeAdapter } from '../node_modules/hermes-live-voice/dist/adapters/outbound/realtime/openai-realtime.adapter.js';
await applyManagedConfigToProcess();
const config = loadConfig();
const events = [];
const session = await new OpenAIRealtimeAdapter(config.openai).connect({ sessionId: 'monte_release_preflight',
  systemInstruction: 'Preflight configuration test. Do not speak.', availableTools: ['set_conversation_mode'], callbacks: { onEvent: e => events.push(e) } });
const metrics = {};
try {
  for (const mode of ['brainstorm', 'work']) {
    const start = performance.now();
    await session.updateConfiguration(`Preflight ${mode} configuration. Do not speak.`, ['set_conversation_mode']);
    metrics[`${mode}ConfigurationMs`] = Math.round(performance.now() - start);
  }
  await session.insertContext('discussion:preflight', 'Preflight context, without a user message or response.');
  if (events.some(e => e.type === 'audio' || e.type === 'response' || e.type === 'tool_call')) throw new Error('Unexpected speech or tool execution during preflight');
  console.log(JSON.stringify({ passed: true, model: config.openai.model, ...metrics, speechEvents: 0 }));
} finally { await session.close(); }
