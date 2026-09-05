// Post final voice transcripts to Discord when on; off is the default.
// Task-result content follows the same setting in DeliveryQueue. Operational
// notices remain enabled. Legacy auto settings are interpreted as off.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MIRROR_MODES = ["on", "off"];

export function normalizeMirrorMode(value, fallback = "off") {
  const v = String(value ?? "").trim().toLowerCase();
  if (/^(1|true|yes|on)$/.test(v)) return "on";
  if (/^(0|false|no|off)$/.test(v)) return "off";
  if (v === "auto") return "off"; // legacy environment/state compatibility
  return fallback;
}

export class MirrorFilter {
  #mode;

  constructor(mode = "off") {
    this.#mode = normalizeMirrorMode(mode);
  }

  get mode() {
    return this.#mode;
  }

  setMode(mode) {
    this.#mode = normalizeMirrorMode(mode, this.#mode);
    return this.#mode;
  }

  /** Lines to post to Discord for this final transcript (possibly none). */
  decide(speaker, text) {
    if (this.#mode === "off" || speaker === "system") return [];
    return [`**${speaker === "user" ? "you" : speaker}:** ${text}`];
  }
}

export async function loadMirrorMode(path) {
  if (!path) return null;
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (data?.mode === "auto") return "off";
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
