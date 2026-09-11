# Normal Hermes voice release validation

September 11, 2026: release **`1.1.0-monte.3`**, protocol **v8**. The gateway fork is committed on `monte-brainstorm-v1`; the exact source revision and artifact hashes are in the [release manifest](../vendor/release.json). The matching SDK, gateway package and complete source archive are included in `vendor/`.

## What was confirmed and corrected

The previous Brainstorm path used the separate restricted research profile. It only exposed repository listing, reading and searching, so it could not run the ordinary Hermes CLI, GitHub or Factory tools. Project registration existed, but the realtime model did not receive a catalog. The gateway also denied pending command approvals instead of presenting them. The installed Hermes approval endpoint expects `request_id`; the prior client used `approval_id`.

Protocol v8 now uses normal Hermes for consultations and explicitly requested small actions, with the same profile, credentials, tools and existing approval rules. A bounded project catalog is restored with discussion context. Approvals remain attached to their original run and can be answered with fresh voice consent or Discord buttons. No blanket approval was enabled and Hermes core was not modified.

The saved normal Hermes systemd definition pointed at the research profile even though its running process used the correct normal profile. A persistent override now sets both `HERMES_HOME` and the working directory to `/home/alex/.hermes`. The already running normal Hermes process was retained.

Live testing also caught a false stale-evidence label for consultations without a selected repository. Unversioned findings now retain their task update time without claiming a failed Git revision comparison. Actual repository revision changes remain distinguishable.

## Automated checks

| Check | Result |
| --- | --- |
| Monte Chat suite against the installed SDK | 117 passed |
| HLV full suite | 775 passed across 42 files |
| Final conversation-instruction adjustment | Seven memory tests passed; package checks rebuilt the final source |
| HLV typecheck and build | Passed |
| HLV package smoke | Passed: 274 files, installation, activation, setup, upgrade, diagnostics, plugin, gateway and doctor |
| HLV gateway smoke | Passed with a fake provider |
| HLV documentation checks | 26 Markdown files passed |
| Installed Hermes approval dispatch tests | 19 passed; 50 unrelated cases deselected |
| Legacy research plugin integration | Four tests and 17 subtests passed |
| Bridge deployment scripts and whitespace checks | Passed |

Coverage includes project-free consultation, Factory target association, normal-backend routing, selected-session lineage, explicit small actions, implementation-mode switching, independent controls during pending work, exact and duplicate approvals, multiple pending commands, owner checks, reconnect recovery, receipt-based Discord posting and rollback that preserves task state. The v7 and v8 WebSocket scenarios each exchange five turns while one investigation remains pending, then verify findings wait for microphone and playback idleness.

## Live provider and service checks

These checks used the configured OpenAI realtime provider and installed normal Hermes. Synthetic PCM and text input are identified separately from a human Discord call.

| Check | Measured result |
| --- | --- |
| Resume the user's selected Hermes history | 1,481 ms; protocol v8 and persisted Brainstorm restored |
| Synthetic spoken PCM: inspect current mode | Recognized input, verified the actual Brainstorm answer, 391,200 output PCM bytes; first audio 707 ms after input ended |
| Realtime project catalog, with no Hermes dispatch | Named all seven projects and identified `wabansia/lng-gg` as Factory's target; 5,109 ms and 1,053,600 output PCM bytes |
| Normal Hermes CLI preflight | GitHub issues #74/#76 both OPEN; Factory classification for #74 was `actionable: false`; 15,582 ms |
| Full realtime → gateway → normal Hermes consultation, no project supplied or selected | Receipt in 3,886 ms; finished spoken findings in 29,450 ms; 2,457,600 output PCM bytes |
| Service probes | Gateway `/ready` returned HTTP 200; protocol v8 advertised; gateway, bridge and normal Hermes active |

The full consultation found issue **#74**, “Keep sessions ending until persistence succeeds and recover failed saves,” and returned the recorded **not actionable** classification. It used the Work backend with consultation purpose and needed no project identifier from the user. All diagnostic consultations reached a terminal state. Repeated probes were isolated discussions; their counts are not a ten-minute conversation measurement.

The catalog contained `ESP32-S3-PhotoPainter`, `hermes-live-voice-monte`, `journal`, `lng-gg`, `monte-board`, `monte-chat` and `monte-factory`. The Factory association distinguishes its orchestration repository from the issue target `wabansia/lng-gg`.

The focused PCM, catalog, normal CLI and full consultation probes are reproducible with the scripts in `deploy/`; set `HERMES_LIVE_CONFIG_FILE=~/.hermes/hermes-live/config.env`. `smoke-focused-voice.mjs --audio` requires FFmpeg's `flite` filter. The consultation check requires Brainstorm already selected and does not change the mode preference.

## Deployment and remaining acceptance

The private pre-rollout backup is `/home/alex/.local/state/monte-chat-rollouts/20260911T051019Z`, with an additional current-state snapshot under `pre-final-state`. It contains voice state, bridge state, prior bridge source, gateway installation, systemd units and drop-ins. Both installed package copies were compared byte for byte with all 274 files in the final artifact. Follow [deployment and rollback instructions](natural-hermes.md#deployment-and-rollback); do not replace current task state with an older backup.

The **ten-minute human Discord design discussion remains pending human participation**, including a deliberately slow investigation, five substantive exchanges, a real spoken/button approval, reconnect, Work handoff, and user-observed mode-switch latency. Automated tests cover those state transitions and approval dispatch, but they do not establish conversational quality or a completed human approval interaction. No such human acceptance result is claimed here.
