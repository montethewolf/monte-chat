import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session-store.js";

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "voice-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json"); const focus = join(dir, "focus.json");
  return { path, focus, store: new SessionStore(path, focus) };
}
test("migration preserves focused target and true default despite a mismatched legacy session", async (t) => {
  const { path, focus, store } = await setup(t);
  const legacy = JSON.stringify({ sessionId: "wrong" });
  await writeFile(path, legacy);
  await writeFile(focus, JSON.stringify({ threadId: "thread", sessionId: "focused", defaultSessionId: "default" }));
  await store.load();
  assert.equal(store.value.defaultSessionId, "default"); assert.equal(store.value.focus.sessionId, "focused");
  await store.save(store.value);
  assert.equal(await readFile(`${path}.legacy`, "utf8"), legacy);
  assert.equal(JSON.parse(await readFile(focus, "utf8")).sessionId, "focused");
  const loaded = new SessionStore(path, focus); await loaded.load(); assert.deepEqual(loaded.value, store.value);
});
test("default-only migration and fresh installations", async (t) => {
  const { path, store } = await setup(t);
  const initial = await store.load();
  assert.equal(initial.version, 3); assert.equal(initial.defaultSessionId, null); assert.equal(initial.focus, null);
  assert.match(initial.defaultDiscussionId, /^discussion_[a-f0-9]{32}$/);
  const reconnect = new SessionStore(path); await reconnect.load(); assert.equal(reconnect.value.defaultDiscussionId, initial.defaultDiscussionId);
  await writeFile(path, JSON.stringify({ sessionId: "saved" }));
  assert.equal((await store.load()).defaultSessionId, "saved");
});
test("corrupt persistence fails closed instead of forgetting conversation", async (t) => {
  const { path, store } = await setup(t); await writeFile(path, "{broken");
  await assert.rejects(store.load(), /refusing to discard/);
  assert.equal(await readFile(path, "utf8"), "{broken");
});
test("aborted queued save cannot overwrite a newer committed state", async (t) => {
  const { path, store } = await setup(t); await store.load();
  const initial = { version: 2, defaultSessionId: "initial", focus: null };
  const first = store.save(initial);
  const abort = new AbortController();
  const stale = store.save({ ...initial, defaultSessionId: "stale" }, { signal: abort.signal });
  abort.abort(); await assert.rejects(stale); await first;
  const next = { ...initial, defaultSessionId: "current" }; await store.save(next);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), next);
});
test("serialized commits never collide on temporary filenames", async (t) => {
  const { path, store } = await setup(t); await store.load();
  await Promise.all(Array.from({ length: 10 }, (_, n) => store.save({ version: 2, defaultSessionId: `s${n}`, focus: null })));
  assert.equal(JSON.parse(await readFile(path, "utf8")).defaultSessionId, "s9");
});
