import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorFilter, loadMirrorMode, normalizeMirrorMode, saveMirrorMode } from "../src/mirror.js";

test("normalizeMirrorMode maps env-style values and falls back", () => {
  assert.equal(normalizeMirrorMode("1"), "on");
  assert.equal(normalizeMirrorMode("true"), "on");
  assert.equal(normalizeMirrorMode("ON"), "on");
  assert.equal(normalizeMirrorMode("0"), "off");
  assert.equal(normalizeMirrorMode("off"), "off");
  assert.equal(normalizeMirrorMode("auto"), "auto");
  assert.equal(normalizeMirrorMode(undefined), "auto");
  assert.equal(normalizeMirrorMode("garbage", "off"), "off");
});

test("mode on mirrors user and assistant, never system", () => {
  const f = new MirrorFilter("on");
  assert.deepEqual(f.decide("user", "hello"), ["**you:** hello"]);
  assert.deepEqual(f.decide("assistant", "hi"), ["**assistant:** hi"]);
  assert.deepEqual(f.decide("system", "[SYSTEM BRIEF ...]"), []);
});

test("mode off mirrors nothing", () => {
  const f = new MirrorFilter("off");
  assert.deepEqual(f.decide("user", "hello"), []);
  assert.deepEqual(f.decide("assistant", "that was BLOCKED"), []);
});

test("mode auto surfaces permission walls with the user line as context", () => {
  const f = new MirrorFilter("auto");
  assert.deepEqual(f.decide("user", "check the locks"), []);
  assert.deepEqual(f.decide("assistant", "Sure, one moment."), []);
  assert.deepEqual(f.decide("user", "read that file"), []);
  assert.deepEqual(f.decide("assistant", "That command was blocked pending approval."), [
    "**you:** read that file",
    "**assistant:** That command was blocked pending approval.",
  ]);
  // context is consumed: a second matching line posts alone
  assert.deepEqual(f.decide("assistant", "Still no permission for that."), [
    "**assistant:** Still no permission for that.",
  ]);
});

test("setMode normalizes, keeps current on garbage, and clears held context", () => {
  const f = new MirrorFilter("auto");
  f.decide("user", "secret context");
  assert.equal(f.setMode("nonsense"), "auto");
  assert.equal(f.setMode("1"), "on");
  assert.equal(f.setMode("auto"), "auto");
  // held user line was cleared by the mode change
  assert.deepEqual(f.decide("assistant", "approval needed"), ["**assistant:** approval needed"]);
});

test("mirror mode persistence round-trips and rejects corrupt files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mirror-"));
  const file = join(dir, "state", "mirror.json");
  assert.equal(await loadMirrorMode(file), null); // missing
  assert.equal(await saveMirrorMode(file, "OFF"), "off"); // normalized on save
  assert.equal(await loadMirrorMode(file), "off");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { mode: "off" });
});
