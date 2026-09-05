// Transcript-mirroring policy: which final voice transcripts get posted to
// Discord. Three modes — "on" (everything), "off" (nothing), "auto" (only
// permission/approval exchanges, so the text channel has context for the
// approve-from-text workflow without a full call log).
//
// The mode lives in its own state file (same reasoning as focus.js: hlv-conn
// owns state.json). The file is the control surface: the hlv-discord-ctl CLI
// (which Hermes runs on request — "stop mirroring" in voice routes through
// continue_hermes_conversation) writes it, and index.js watches it for
// changes, so a flip applies mid-call without a restart.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MIRROR_MODES = ["on", "off", "auto"];

export function normalizeMirrorMode(value, fallback = "auto") {
  const v = String(value ?? "").trim().toLowerCase();
  if (/^(1|true|yes|on)$/.test(v)) return "on";
  if (/^(0|false|no|off)$/.test(v)) return "off";
  if (v === "auto") return "auto";
  return fallback;
}

// Assistant lines worth surfacing in auto mode: permission walls and approval
// talk. False positives are cheap (one extra line in the channel); misses are
// not (the approve-from-text flow loses its context).
const BLOCKED_RE = /block\w*|approv\w*|permission\w*|\bdenied\b|not allowed/i;

export class MirrorFilter {
  #mode;
  #pendingUser = null;

  constructor(mode = "auto") {
    this.#mode = normalizeMirrorMode(mode);
  }

  get mode() {
    return this.#mode;
  }

  setMode(mode) {
    this.#mode = normalizeMirrorMode(mode, this.#mode);
    this.#pendingUser = null;
    return this.#mode;
  }

  /** Lines to post to Discord for this final transcript (possibly none). */
  decide(speaker, text) {
    if (this.#mode === "off" || speaker === "system") return [];
    const line = `**${speaker === "user" ? "you" : speaker}:** ${text}`;
    if (this.#mode === "on") return [line];
    // auto: hold the latest user line; emit it as context when the assistant
    // hits a permission wall.
    if (speaker === "user") {
      this.#pendingUser = line;
      return [];
    }
    if (speaker === "assistant" && BLOCKED_RE.test(text)) {
      const out = this.#pendingUser ? [this.#pendingUser, line] : [line];
      this.#pendingUser = null;
      return out;
    }
    return [];
  }
}

export async function loadMirrorMode(path) {
  if (!path) return null;
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    return MIRROR_MODES.includes(data?.mode) ? data.mode : null;
  } catch {
    return null; // missing or corrupt: caller falls back to the env default
  }
}

export async function saveMirrorMode(path, mode) {
  if (!path) return;
  const normalized = normalizeMirrorMode(mode);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify({ mode: normalized }), "utf8");
  await rename(tmp, path);
  return normalized;
}
