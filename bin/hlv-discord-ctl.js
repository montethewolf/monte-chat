#!/usr/bin/env node
// Control CLI for the running hlv-discord bridge. Designed to be run by
// Hermes itself (e.g. the user says "stop mirroring" in a voice call, the
// voice model passes it to Hermes, Hermes runs this). State changes are
// written to the bridge's state files, which the service watches — no
// restart, applies mid-call.
//
//   hlv-discord-ctl mirror            -> print current mode
//   hlv-discord-ctl mirror on|off|auto -> set mode

import { homedir } from "node:os";
import { join } from "node:path";
import { MIRROR_MODES, loadMirrorMode, normalizeMirrorMode, saveMirrorMode } from "../src/mirror.js";

const MIRROR_STATE_FILE =
  process.env.MIRROR_STATE_FILE ?? join(homedir(), ".local", "state", "hlv-discord", "mirror.json");

function usage() {
  console.log("usage: hlv-discord-ctl mirror [on|off|auto|status]");
  process.exit(2);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd !== "mirror") usage();

if (!arg || arg === "status") {
  const mode = (await loadMirrorMode(MIRROR_STATE_FILE)) ?? "auto (default)";
  console.log(`transcript mirroring: ${mode}`);
  process.exit(0);
}

if (!MIRROR_MODES.includes(normalizeMirrorMode(arg, ""))) usage();
const mode = await saveMirrorMode(MIRROR_STATE_FILE, arg);
console.log(`transcript mirroring: ${mode}`);
