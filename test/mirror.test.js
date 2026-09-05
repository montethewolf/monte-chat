import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { MIRROR_MODES, MirrorFilter, loadMirrorMode, normalizeMirrorMode, saveMirrorMode } from "../src/mirror.js";

const run = promisify(execFile);
async function stateFile(t) {
  const dir = await mkdtemp(join(tmpdir(), "mirror-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "mirror.json");
}

test("two modes default off; environment aliases remain supported and legacy auto becomes off", () => {
  assert.deepEqual(MIRROR_MODES, ["on", "off"]);
  for (const value of ["1", "true", "ON", "yes"]) assert.equal(normalizeMirrorMode(value), "on");
  for (const value of ["0", "off", "false", "no", "auto", undefined, "garbage"]) {
    assert.equal(normalizeMirrorMode(value), "off");
  }
  assert.equal(normalizeMirrorMode("auto", "on"), "off");
});

test("on mirrors all final user and assistant lines, never system", () => {
  const f = new MirrorFilter("on");
  assert.deepEqual(f.decide("user", "hello"), ["**you:** hello"]);
  assert.deepEqual(f.decide("assistant", "hi"), ["**assistant:** hi"]);
  assert.deepEqual(f.decide("system", "[SYSTEM BRIEF ...]"), []);
});

test("default, off, and legacy auto suppress even approval exchanges", () => {
  for (const mode of [undefined, "off", "auto"]) {
    const f = new MirrorFilter(mode);
    assert.equal(f.mode, "off");
    assert.deepEqual(f.decide("user", "private request"), []);
    assert.deepEqual(f.decide("assistant", "That was blocked pending approval"), []);
  }
});

test("switching on does not replay speech from when mirroring was off", () => {
  const f = new MirrorFilter();
  f.decide("user", "secret context");
  assert.equal(f.setMode("on"), "on");
  assert.deepEqual(f.decide("assistant", "approval needed"), ["**assistant:** approval needed"]);
  assert.equal(f.setMode("nonsense"), "on");
  assert.equal(f.setMode("off"), "off");
  assert.deepEqual(f.decide("assistant", "next reply"), []);
});

test("saved auto is read as off, on/off survive, and the next write stores only the new mode", async (t) => {
  const file = await stateFile(t);
  assert.equal(await loadMirrorMode(file), null);
  await writeFile(file, JSON.stringify({ mode: "auto" }));
  assert.equal(await loadMirrorMode(file), "off");
  for (const mode of ["on", "off"]) {
    await saveMirrorMode(file, mode);
    assert.equal(await loadMirrorMode(file), mode);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { mode });
  }
  await writeFile(file, "{broken"); assert.equal(await loadMirrorMode(file), null);
  await writeFile(file, JSON.stringify({ mode: "invalid" })); assert.equal(await loadMirrorMode(file), null);
});

test("CLI reports off by default, respects saved state, and rejects auto without changing state", async (t) => {
  const file = await stateFile(t);
  const cli = fileURLToPath(new URL("../bin/hlv-discord-ctl.js", import.meta.url));
  const invoke = (...args) => run(process.execPath, [cli, "mirror", ...args], {
    env: { ...process.env, MIRROR_STATE_FILE: file, MIRROR_TRANSCRIPTS: "" },
  });
  assert.match((await invoke("status")).stdout, /voice conversation to text: off/);
  await invoke("on"); assert.equal(await loadMirrorMode(file), "on");
  await assert.rejects(invoke("auto"), (err) => err.code === 2);
  assert.equal(await loadMirrorMode(file), "on");
  await invoke("off"); assert.equal(await loadMirrorMode(file), "off");
  await writeFile(file, JSON.stringify({ mode: "auto" }));
  assert.match((await invoke()).stdout, /voice conversation to text: off/);
});
