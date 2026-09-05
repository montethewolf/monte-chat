---
name: hlv-discord-voice-bridge
description: Control Alex's Discord voice bridge (hlv-discord) — especially transcript mirroring. Use when the user asks to start/stop/change mirroring of voice transcripts to Discord, asks whether mirroring is on, or asks about the voice bridge service itself. Requests may arrive from a live voice call (relayed by the voice model) or from text chat — handle both the same way.
---

# hlv-discord voice bridge control

Alex talks to you by voice through a Discord bridge service (`hlv-discord`,
in `~/Development/monte-chat`, systemd user unit `hlv-discord.service`).
The bridge can mirror the call's transcripts into the Discord text channel.

## Transcript mirroring

Post voice conversation to text with two settings:

- `on` — post Alex's words, your replies, and task results to the selected
  Discord channel or focused thread.
- `off` (default) — transcripts and task-result content are suppressed; operational
  notices (connection failures, recovery, and mode changes) still post.
  Content already handed to Discord cannot be recalled.

Control it with the CLI (applies immediately, mid-call, no restart):

```sh
/home/alex/.npm-global/bin/hlv-discord-ctl mirror status   # show current mode
/home/alex/.npm-global/bin/hlv-discord-ctl mirror on
/home/alex/.npm-global/bin/hlv-discord-ctl mirror off
```

(`hlv-discord-ctl` is also on PATH.) When the user says things like "stop
mirroring", "mirror this call", "turn text posts off" —
run the matching command and confirm with its one-line output. The bridge
posts a status line to the Discord channel when the mode changes, so don't
post an extra announcement yourself.

## Notes

- Mirroring affects Discord text posts only, not Hermes memory or background tasks.
- Legacy `auto` settings are interpreted as `off`; use only `on` and `off`.
- The mode persists in `~/.local/state/hlv-discord/mirror.json` and survives
  service restarts. `MIRROR_TRANSCRIPTS` in `~/.config/hlv-discord/env` is
  only the first-boot default.
- The `/mirror` Discord slash command does the same thing by hand.
- Do not restart `hlv-discord.service` for mirroring changes; a restart is
  only for code updates or if Alex reports the bridge itself is broken
  (`systemctl --user restart hlv-discord.service`).
