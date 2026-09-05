---
name: hlv-discord-voice-bridge
description: Control Alex's Discord voice bridge (hlv-discord) — especially transcript mirroring. Use when the user asks to start/stop/change mirroring of voice transcripts to Discord, asks whether mirroring is on, or asks about the voice bridge service itself. Requests may arrive from a live voice call (relayed by the voice model) or from text chat — handle both the same way.
---

# hlv-discord voice bridge control

Alex talks to you by voice through a Discord bridge service (`hlv-discord`,
in `~/Development/monte-chat`, systemd user unit `hlv-discord.service`).
The bridge can mirror the call's transcripts into the Discord text channel.

## Transcript mirroring

Three modes:

- `on` — every final transcript line is posted to Discord (noisy; Alex
  usually doesn't want this for long).
- `off` — nothing is posted.
- `auto` (default) — only permission/approval exchanges are posted, so the
  approve-from-text workflow has context without a full call log.

Control it with the CLI (applies immediately, mid-call, no restart):

```sh
/home/alex/.npm-global/bin/hlv-discord-ctl mirror status   # show current mode
/home/alex/.npm-global/bin/hlv-discord-ctl mirror on
/home/alex/.npm-global/bin/hlv-discord-ctl mirror off
/home/alex/.npm-global/bin/hlv-discord-ctl mirror auto
```

(`hlv-discord-ctl` is also on PATH.) When the user says things like "stop
mirroring", "mirror this call", "turn the transcript log back to automatic" —
run the matching command and confirm with its one-line output. The bridge
posts a status line to the Discord channel when the mode changes, so don't
post an extra announcement yourself.

## Notes

- The mode persists in `~/.local/state/hlv-discord/mirror.json` and survives
  service restarts. `MIRROR_TRANSCRIPTS` in `~/.config/hlv-discord/env` is
  only the first-boot default.
- The `/mirror` Discord slash command does the same thing by hand.
- Do not restart `hlv-discord.service` for mirroring changes; a restart is
  only for code updates or if Alex reports the bridge itself is broken
  (`systemctl --user restart hlv-discord.service`).
