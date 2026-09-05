import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const empty = () => ({ version: 2, defaultSessionId: null, focus: null });
const validId = (id) => id === null || (typeof id === "string" && id.length > 0);
export class SessionStore {
  constructor(path, legacyFocusPath) {
    this.path = path;
    this.legacyFocusPath = legacyFocusPath;
    this.value = empty();
    this.tail = Promise.resolve();
  }
  async load() {
    let data = null;
    let raw;
    try { raw = await readFile(this.path, "utf8"); data = JSON.parse(raw); }
    catch (err) { if (err.code !== "ENOENT") throw new Error("Session state is unreadable; refusing to discard saved context"); }
    if (data?.version === 2) {
      if (!validId(data.defaultSessionId) || (data.focus !== null &&
        (!data.focus?.threadId || !validId(data.focus.sessionId) || !data.focus.sessionId))) {
        throw new Error("Invalid session state; saved context preserved");
      }
      this.value = data;
      return this.value;
    }
    if (data && !validId(data.sessionId)) throw new Error("Invalid legacy session state");
    let focus = null;
    try {
      if (this.legacyFocusPath) focus = JSON.parse(await readFile(this.legacyFocusPath, "utf8"));
      if (focus && (!focus.threadId || !focus.sessionId)) throw new Error("invalid focus");
    } catch (err) { if (err.code !== "ENOENT") throw new Error("Legacy focus is unreadable; saved context preserved"); }
    this.value = { version: 2, defaultSessionId: focus ? focus.defaultSessionId ?? null : data?.sessionId ?? null, focus };
    this.legacyRaw = raw;
    return this.value;
  }
  save(next, { signal } = {}) {
    const snapshot = structuredClone(next);
    const operation = this.tail.then(async () => {
      signal?.throwIfAborted();
      const previous = this.value;
      await mkdir(dirname(this.path), { recursive: true });
      if (this.legacyRaw !== undefined) {
        try { await writeFile(`${this.path}.legacy`, this.legacyRaw, { flag: "wx", mode: 0o600 }); }
        catch (err) { if (err.code !== "EEXIST") throw err; }
        this.legacyRaw = undefined;
      }
      const tmp = `${this.path}.tmp-${process.pid}`;
      try {
        await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
        signal?.throwIfAborted();
        await rename(tmp, this.path);
        if (signal?.aborted) {
          await writeFile(tmp, JSON.stringify(previous), { mode: 0o600 });
          await rename(tmp, this.path);
          signal.throwIfAborted();
        }
        this.value = snapshot;
        return snapshot;
      } finally { await unlink(tmp).catch(() => {}); }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
