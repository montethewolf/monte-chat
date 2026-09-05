import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeliveryQueue } from "../src/delivery.js";
import { saveMirrorMode } from "../src/mirror.js";
import { watchMirrorMode } from "../src/mirror-watch.js";

test("ordered chunks retry in place with stable nonce, disabled mentions, and captured destination", async () => {
  const sent = []; let attempts = 0; const nonces = [];
  const queue = new DeliveryQueue({ mode: () => "on", retryMs: 1, send: async (target, message) => {
    nonces.push(message.nonce);
    if (++attempts === 1) throw new Error("temporary");
    sent.push({ target, ...message });
  } });
  queue.enqueue({ text: "@everyone" + "a".repeat(2000), target: "original", kind: "transcript" });
  queue.enqueue({ text: "next", target: "new", kind: "transcript" });
  await queue.idle();
  assert.deepEqual(sent.map((m) => m.target), ["original", "original", "new"]);
  assert.equal(sent[0].content.length, 1900); assert.equal(sent[2].content, "next");
  assert.equal(nonces[0], nonces[1]);
  assert.ok(sent.every((m) => m.enforceNonce && m.allowedMentions.parse.length === 0));
});
test("off removes queued sensitive content, keeps operational notices, and rejects future task results", async () => {
  let mode = "on"; let release; const sent = [];
  const queue = new DeliveryQueue({ mode: () => mode, send: async (_target, message) => {
    if (message.content === "in flight") await new Promise((r) => { release = r; });
    sent.push(message.content);
  } });
  queue.enqueue({ text: "in flight", target: "a" });
  queue.enqueue({ text: "private transcript", target: "a", kind: "transcript" });
  queue.enqueue({ text: "private result", target: "a", kind: "content" });
  queue.enqueue({ text: "reconnecting", target: "a" });
  mode = "off"; queue.policyChanged();
  queue.enqueue({ text: "another result", target: "a", kind: "content" });
  release(); await queue.idle(); assert.deepEqual(sent, ["in flight", "reconnecting"]);
});
test("missing/forbidden destination is counted without fallback or leaking text into logs", async () => {
  const logs = []; const targets = [];
  const queue = new DeliveryQueue({ log: (text) => logs.push(text), send: async (target) => {
    targets.push(target); throw Object.assign(new Error("secret detail"), { status: 403 });
  } });
  queue.enqueue({ text: "secret", target: null });
  queue.enqueue({ text: "secret", target: "focused" });
  await queue.idle(); assert.equal(queue.failures, 2); assert.deepEqual(targets, ["focused"]);
  assert.ok(logs.every((s) => !s.includes("secret")));
});
test("deduplicates notification IDs per destination", async () => {
  const sent = []; const queue = new DeliveryQueue({ mode: () => "on", send: async (target, message) => sent.push([target, message.content]) });
  for (let n = 0; n < 5; n++) queue.enqueue({ text: "result", target: "a", key: "notification:1", kind: "content" });
  queue.enqueue({ text: "result", target: "b", key: "notification:1", kind: "content" });
  await queue.idle(); assert.equal(sent.length, 2);
});
test("delivery has finite retry, capacity, and age limits", async () => {
  let attempts = 0; const queue = new DeliveryQueue({ retryMs: 1, send: async () => { attempts++; throw new Error("temporary"); } });
  queue.enqueue({ text: "a", target: "a" }); await queue.idle();
  assert.equal(attempts, 3); assert.equal(queue.failures, 1);
  let now = 0; let release;
  const bounded = new DeliveryQueue({ capacity: 2, ttlMs: 10, now: () => now,
    send: async () => new Promise((r) => { release = r; }) });
  bounded.enqueue({ text: "a", target: "a" }); bounded.enqueue({ text: "b", target: "b" });
  bounded.enqueue({ text: "overflow", target: "c" });
  now = 20; release(); await bounded.idle(); assert.equal(bounded.failures, 2);
});
test("first-boot watcher sees atomic CLI writes in a newly created directory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "voice-mirror-"));
  const path = join(dir, "new", "mirror.json");
  let resolve; const changed = new Promise((r) => { resolve = r; });
  const watcher = await watchMirrorMode(path, resolve, { delayMs: 1 });
  t.after(async () => { watcher.close(); await rm(dir, { recursive: true, force: true }); });
  await saveMirrorMode(path, "off");
  const mode = await Promise.race([changed, new Promise((_r, reject) => { const timer = setTimeout(() => reject(new Error("watch timeout")), 1000); timer.unref(); })]);
  assert.equal(mode, "off");
});
test("delivery defaults off and fails closed for legacy or invalid modes", async () => {
  for (const mode of [undefined, () => "auto", () => "invalid"]) {
    const sent = [];
    const queue = new DeliveryQueue({ ...(mode ? { mode } : {}), send: async (_target, message) => sent.push(message.content) });
    queue.enqueue({ text: "private dialogue", target: "a", kind: "transcript" });
    queue.enqueue({ text: "private result", target: "a", kind: "content" });
    queue.enqueue({ text: "reconnecting", target: "a" });
    await queue.idle();
    assert.deepEqual(sent, ["reconnecting"]);
  }
});
