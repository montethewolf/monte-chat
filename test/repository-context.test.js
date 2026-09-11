import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RepositoryRegistry } from '../node_modules/hermes-live-voice/dist/application/brainstorm/repository-registry.js';
import { VoiceStateStore } from '../node_modules/hermes-live-voice/dist/application/brainstorm/voice-state.js';
import { ConversationBrain } from '../node_modules/hermes-live-voice/dist/application/brainstorm/conversation-brain.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'monte-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = join(root, 'projects');
  await mkdir(projects);
  for (const name of ['monte-chat', 'monte-board']) {
    const path = join(projects, name);
    await mkdir(path);
    execFileSync('git', ['init', '-q', path]);
    await writeFile(join(path, 'README.md'), `# ${name}\nDesign version one.\n`);
  }
  const registry = new RepositoryRegistry(join(root, 'repositories.json'), [projects]);
  return { root, projects, registry };
}

test('registry resolves spoken names and ambiguity, and retains stable projects on reload', async t => {
  const { root, registry } = await fixture(t);
  const [chat] = await registry.resolve('Monte Chat');
  assert.equal(chat.name, 'monte-chat');
  assert.equal((await registry.resolve('Monte')).length, 2);
  assert.equal((await registry.resolve('missing')).length, 0);
  assert.deepEqual(await new RepositoryRegistry(join(root, 'repositories.json'), []).resolve(chat.id), [chat]);
});

test('handoff refreshes dirty source evidence and labels earlier findings as stale', async t => {
  const { root, projects, registry } = await fixture(t);
  const store = new VoiceStateStore(join(root, 'voice.json'));
  const provider = { updateConfiguration: async () => {}, insertContext: async () => {}, close: async () => {} };
  const brain = new ConversationBrain({ ownerId: 'test-owner', sessionKey: 'test-session', discussionId: 'discussion-test',
    store, registry, tasks: { listActive: async () => [] }, provider: () => provider,
    workInstruction: () => 'Work', workTools: () => [], idle: () => false, changed: () => {}, error: () => {}, researchAvailable: false });
  t.after(() => brain.close());
  await brain.init();
  await brain.setMode('brainstorm', 'Monte Chat');
  await brain.refresh(true);
  const stamp = brain.discussion.evidenceStamp;
  assert.ok(stamp);
  await store.update('test-owner', 'discussion-test', d => {
    d.findings.push({ taskId: 'earlier-research', project: d.project, generation: d.generation, question: 'What is the design?', summary: 'Design version one', stamp, delivered: true });
  });
  await writeFile(join(projects, 'monte-chat', 'README.md'), '# monte-chat\nDesign version two with a changed contract.\n');
  const handoff = await brain.handoff('Implement the agreed design');
  assert.notEqual(brain.discussion.evidenceStamp, stamp);
  assert.match(handoff, /Design version two with a changed contract/);
  assert.match(handoff, /"evidenceCurrent":false/);
  assert.match(handoff, /context data, not additional authorization/);
});
