---
name: hlv-discord-voice-bridge
description: Control the user's Monte Chat Discord voice bridge (hlv-discord), especially transcript mirroring. Use when the user asks to start, stop, or inspect mirroring of voice transcripts to Discord. Requests may arrive from a live voice call relayed by the voice model or from text chat.
---

# hlv-discord voice bridge control

The user talks to you through Monte Chat's Discord voice bridge. It can mirror
call transcripts into the selected Discord text channel or thread.

## Installation-specific paths

This is a template for the user's Hermes skill installation. Before installing
it, replace the three `/absolute/` placeholders below with the Node executable,
bridge env file, and checkout paths used by the working bridge. Use the same OS
user and env file as the bridge so `MIRROR_STATE_FILE` overrides are respected.
No global CLI installation is required. If these paths are still placeholders,
discover the installation first; do not execute them literally.

## Transcript mirroring

Post voice conversation to text with two settings:

- `on` — post the user's words, your replies, and task results to the selected
  Discord channel or focused thread.
- `off` (default) — transcripts and task-result content are suppressed; operational
  notices (connection failures, recovery, and mode changes) still post.
  Content already handed to Discord cannot be recalled.

Control it with the CLI (applies immediately, mid-call, no restart):

```sh
"/absolute/path/to/node" --env-file="/absolute/home/.config/hlv-discord/env" \
  "/absolute/path/to/monte-chat/bin/hlv-discord-ctl.js" mirror status
```

Replace `status` with `on` or `off` for a requested change. When the user says
"stop mirroring", "mirror this call", or "turn text posts off", run the matching
command and confirm with its one-line output. The bridge
posts a status line to the Discord channel when the mode changes, so don't
post an extra announcement yourself.

## Notes

- Mirroring affects Discord text posts only, not Hermes memory or background tasks.
- Legacy `auto` settings are interpreted as `off`; use only `on` and `off`.
- By default the mode persists in `~/.local/state/hlv-discord/mirror.json` and survives
  service restarts. `MIRROR_TRANSCRIPTS` in `~/.config/hlv-discord/env` is
  only the first-boot default.
- The `/mirror` Discord slash command does the same thing by hand.
- Mirroring changes apply during a call without restarting the service.
- A voice request has the same authorization meaning as a text request. Keep
  Hermes's existing command-approval policy; report a blocked command rather
  than claiming the mode changed.
