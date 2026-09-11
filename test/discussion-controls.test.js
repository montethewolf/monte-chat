import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscussionControls } from '../src/discussion-controls.js';

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'monte-controls-')); t.after(() => rm(root, { recursive: true, force: true }));
  const conn = new EventEmitter(), sent = [], reports = [], approvals = [], edits = [];
  conn.reportPostResult = (...args) => reports.push(args);
  conn.respondApproval = async (...args) => approvals.push(args);
  const client = { channels: { fetch: async target => ({ guildId: '1', send: async message => {
    sent.push({ target, message }); return { id: String(sent.length), edit: async value => edits.push(value) };
  } }) } };
  const options = { conn, client, guildId: '1', userId: '2', target: () => '3', stateFile: join(root, 'posts.json') };
  return { controls: new DiscussionControls(options), options, conn, sent, reports, approvals, edits };
}
test('explicit posts retain destination, disable mentions and survive duplicate delivery and restart', async t => {
  const { controls, options, sent, reports } = await harness(t);
  const event = { receipt: 'post_a', origin: { guildId: '1', userId: '2', channelId: '3', threadId: '4' }, text: '@everyone accepted notes' };
  await controls.post(event); await controls.post(event); await new DiscussionControls(options).post(event);
  assert.equal(sent.length, 1); assert.equal(sent[0].target, '4'); assert.deepEqual(sent[0].message.allowedMentions, { parse: [] });
  assert.equal(sent[0].message.enforceNonce, true); assert.equal(reports[2][1].messageId, '1');
  await controls.post({ ...event, text: 'changed text' }); assert.equal(reports.at(-1)[1].ok, false);
  assert.equal(JSON.parse(await readFile(options.stateFile, 'utf8')).posts.post_a.result.ok, true);
});
test('approval buttons verify user, guild, message and pending request and submit once', async t => {
  const { controls, conn, approvals, sent } = await harness(t);
  const event = { taskId: 'task_a', runId: 'run_a', approvalRequestId: 'request_a', command: 'approved command', description: 'Requested action', choices: ['once', 'deny'] };
  await controls.present(event); await controls.present(event); assert.equal(sent.length, 1);
  const key = controls.key(event), replies = [];
  const interaction = { isButton: () => true, customId: `monte-approval:${key}:once`, user: { id: '9' }, guildId: '1', message: { id: '1' },
    reply: async v => replies.push(v), deferReply: async () => {}, editReply: async v => replies.push(v) };
  await controls.interaction(interaction); assert.equal(approvals.length, 0);
  await controls.interaction({ ...interaction, user: { id: '2' }, message: { id: 'unrelated' } }); assert.equal(approvals.length, 0);
  await controls.interaction({ ...interaction, user: { id: '2' } });
  await controls.interaction({ ...interaction, user: { id: '2' } });
  assert.deepEqual(approvals, [['task_a', 'run_a', 'request_a', 'once']]);
  conn.emit('task.approval.resolved', { ...event, state: 'resolved', choice: 'once' }); await controls.tail;
  assert.equal(controls.approvals.size, 0);
});
test('wrong origins and interrupted post receipts cannot trigger duplicate sends', async t => {
  const { controls, sent, reports } = await harness(t);
  const event = { receipt: 'post_x', origin: { guildId: '1', userId: '9', channelId: '3' }, text: 'notes' };
  await controls.post(event); assert.equal(sent.length, 0); assert.equal(reports.at(-1)[1].ok, false);
  event.origin.userId = '2'; await controls.loadPosts();
  controls.posts.post_x = { fingerprint: 'interrupted' }; await controls.savePosts();
  await controls.post(event); assert.equal(sent.length, 0);
});
