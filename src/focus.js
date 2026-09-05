// Focus state: which Discord thread (and its Hermes session) the voice call
// is bound to. Kept in its own file — hlv-conn.js owns state.json and rewrites
// it as {sessionId} on every session change, which would clobber focus fields.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function loadFocus(path) {
  if (!path) return null;
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (typeof data?.threadId !== "string" || typeof data?.sessionId !== "string") return null;
    return data;
  } catch {
    return null; // missing or corrupt: not focused
  }
}

export async function saveFocus(path, focus) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(focus), "utf8");
  await rename(tmp, path);
}

export async function clearFocus(path) {
  if (!path) return;
  try {
    await unlink(path);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}
