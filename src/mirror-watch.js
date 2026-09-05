import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { loadMirrorMode } from "./mirror.js";

export async function watchMirrorMode(path, apply, { delayMs = 150, log = () => {} } = {}) {
  await mkdir(dirname(path), { recursive: true });
  let timer; let closed = false;
  const reload = async () => {
    const mode = await loadMirrorMode(path);
    if (!closed && mode !== null) apply(mode);
  };
  const watcher = watch(dirname(path), (_event, filename) => {
    if (filename && filename !== basename(path)) return;
    clearTimeout(timer); timer = setTimeout(() => void reload(), delayMs);
  });
  watcher.on("error", () => log("Mirror state watch failed; /mirror remains available"));
  await reload(); // closes the read-before-watch startup race
  return { close() { closed = true; clearTimeout(timer); watcher.close(); } };
}
