import test from "node:test";
import assert from "node:assert/strict";
import { BriefSender } from "../src/brief-sender.js";

test("asynchronous brief is discarded after rebind or leave", async () => {
  for (const transition of ["rebind", "leave"]) {
    const sent = []; let release;
    const conn = { connected: true, generation: 1, sessionId: "a", sendText: (text) => sent.push(text) };
    const controller = { generation: 1, focusState: { threadId: "a", title: "A" } };
    const sender = new BriefSender({ conn, controller, status: { snapshot: () => new Promise((r) => { release = r; }) } });
    const pending = sender.send(null, true);
    if (transition === "rebind") conn.generation++;
    else { controller.generation++; conn.connected = false; }
    release({}); assert.equal(await pending, false); assert.equal(sent.length, 0);
  }
});
test("same-session reconnect is throttled, focus change and explicit refresh are not", async () => {
  const sent = [];
  const conn = { connected: true, generation: 1, sessionId: "a", sendText: (text) => sent.push(text) };
  const controller = { generation: 1, focusState: null };
  const sender = new BriefSender({ conn, controller, status: { snapshot: async () => ({}) } });
  assert.equal(await sender.send(), true);
  conn.generation++;
  assert.equal(await sender.send(), false);
  controller.focusState = { threadId: "a", title: "A" };
  assert.equal(await sender.send(), true);
  assert.equal(await sender.send(null, true), true); assert.equal(sent.length, 3);
});


test('v7 briefs insert labelled context without a synthetic user turn', async () => {
  const contexts = [], userTurns = [];
  const conn = { connected: true, generation: 1, sessionId: 'a', session: { protocolVersion: 7 },
    sendContext: text => contexts.push(text), sendText: text => userTurns.push(text) };
  const sender = new BriefSender({ conn, controller: { generation: 1, focusState: null }, status: { snapshot: async () => ({}) } });
  assert.equal(await sender.send(), true); assert.equal(contexts.length, 1); assert.equal(userTurns.length, 0);
});
