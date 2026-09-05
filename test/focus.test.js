import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFocus, loadFocus, saveFocus } from "../src/focus.js";

async function tmpFocusPath() {
  const dir = await mkdtemp(join(tmpdir(), "focus-test-"));
  return join(dir, "nested", "focus.json"); // exercise mkdir -p
}

test("focus state round-trips", async () => {
  const path = await tmpFocusPath();
  const focus = {
    threadId: "123",
    chatId: "123",
    sessionId: "sess_a",
    title: "Kokoro API",
    messageCount: 30,
    defaultSessionId: "api_default",
    focusedAt: "2026-09-05T12:00:00Z",
  };
  await saveFocus(path, focus);
  assert.deepEqual(await loadFocus(path), focus);
});

test("missing, corrupt, or incomplete focus files read as not-focused", async () => {
  const path = await tmpFocusPath();
  assert.equal(await loadFocus(path), null);
  await saveFocus(path, { threadId: "1", sessionId: "s" });
  await writeFile(path, "{not json");
  assert.equal(await loadFocus(path), null);
  await writeFile(path, JSON.stringify({ threadId: "1" })); // no sessionId
  assert.equal(await loadFocus(path), null);
  assert.equal(await loadFocus(null), null);
});

test("clearFocus is idempotent", async () => {
  const path = await tmpFocusPath();
  await saveFocus(path, { threadId: "1", sessionId: "s" });
  await clearFocus(path);
  assert.equal(await loadFocus(path), null);
  await clearFocus(path); // second clear must not throw
});
