# Project context and normal Hermes access

Release `1.1.0-monte.3` pairs the HLV gateway and SDK on protocol v8. Brainstorm consultations now use the ordinary Hermes service and profile, including its CLI, GitHub login, skills and existing approval rules. They return a receipt immediately, leaving voice conversation available. The separate restricted researcher remains available for previously accepted research and v7 clients; v8 never routes new consultations there.

The initial discussion includes an 8,000-character project catalog: readable names, short descriptions, local paths, normalized GitHub remotes and Factory associations. `list_projects` discovers additional matches. The catalog refreshes in the background every five minutes and on context changes or unresolved selections. `consult_hermes` can investigate without a selected project. The Factory registry entry identifies its configured target repository and `factoryq` path; Factory issue numbers refer to that target, not necessarily Monte Factory's source repository.

Project IDs and selections remain stable. Optional `overrides.description`, `overrides.aliases` and `overrides.repositories` in the registry customize discovered metadata; restart after manual edits. Repository roots still use `HERMES_LIVE_REPOSITORY_ROOTS`. Registry files retain their compatible v1 envelope, with additive metadata. Existing discussion memory bounds and separation between focused threads remain unchanged.

Findings without a local Git revision are labelled unversioned, rather than stale. Saved task update times distinguish a newly returned lookup from evidence restored on reconnect; repository revision changes retain their separate freshness check.

Explicit small actions use normal Hermes and retain Brainstorm. Explicit implementation requests switch to Work first; hypothetical design questions remain conversational. “Post these notes here” uses the focused Discord thread, or the call's bound text channel when unfocused, with private delivery receipts and duplicate protection. Posting is independent of transcript mirroring. A delivery with an uncertain outcome is not automatically resubmitted.

Command approvals stay on the same Hermes run. The voice model explains the command at an idle pause and accepts a fresh explicit response; Discord buttons offer the same choices. Approve once is the default. Session and permanent choices appear only if Hermes offers them and require explicit selection. They retain Hermes's scope semantics: a Hermes API session approval belongs to the run's approval session, not every future voice task. Silence is not approval. Hermes retains its existing timeout. Expired or already answered requests cannot execute a command again.

# Interfaces and migration

Protocol v8 adds trusted Discord origin metadata, `task.approval.requested`, `task.approval.respond`, `task.approval.resolved`, `discussion.post.requested`, and `discussion.post.result`. Approvals carry the exact task, run and upstream request identities. SDK `respondApproval` and `reportPostResult` support the new controls. Mode and discussion controls remain independent of pending Hermes requests. The gateway continues accepting protocols v3–v7; legacy requests retain their prior approval containment behavior.

Task document version 2 accepts existing version 1 records. New records distinguish consultation/action/implementation purpose from Work/Research backend, retain origin and selected-session bindings, and persist pending command approvals. Selected-conversation Work uses durable runs and resolves the current Hermes session lineage before dispatch; independent consultations use helper sessions. Normal consultations use exclusive scheduling because normal tools are available. Findings stay associated with their originating discussion and topic and are never treated as instructions.

The installed Hermes API uses `request_id`, not `approval_id`, in `POST /v1/runs/{run_id}/approval`. Its existing run ownership and approval machinery are retained. No Hermes core edits or blanket approval setting are needed. The normal service's profile override also prevents the old research-profile service definition from changing ordinary Hermes's profile on its next restart.

# Deployment and rollback

1. Keep a private backup of both voice state directories, bridge source and lockfile, gateway installation, and affected systemd units/drop-ins. Do not replace current task state with an older backup.
2. Install the pinned SDK with `npm ci`. Install the identical `vendor/hermes-live-voice-1.1.0-monte.3.tgz` under `~/.local/share/monte-chat/gateway` using `npm install --omit=dev --ignore-scripts --prefix`.
3. Install `deploy/hermes-normal-profile.conf` as `~/.config/systemd/user/hermes-gateway.service.d/normal-profile.conf`, then reload systemd. The already running normal Hermes process need not restart if it already uses `~/.hermes`. Keep the legacy research service for v7 clients and retained records.
4. Restart `dev.hermes-live-voice.gateway.service` and `hlv-discord.service`. Verify both installed package versions, `/ready`, protocol v8 capabilities and normal Hermes tools. Run the focused PCM voice probe and read-only GitHub/Factory consultation checks.
5. For rollback to `monte.2`, finish or stop outstanding v8 tasks, stop the two voice services, and run `python3 deploy/prepare-v7-rollback.py --tasks ~/.hermes/hermes-live/tasks-v1.json`. It snapshots and converts current task state, refusing active v8 tasks. Restore the prior bridge source/lockfile and matching gateway package, then restart. Preserve the corrected normal-profile override, discussion notes, repository metadata and post receipts.

# Acceptance

Automated coverage uses temporary repositories/state, fake realtime providers, the real browser protocol, Discord delivery fakes and the installed Hermes approval dispatch tests. Check project-free discovery, Factory target mapping, small actions, focused posting, selected-session execution, mode switching during pending work, exact and duplicate approvals, queued approvals, reconnect, topic changes and playback interruption.

Live acceptance includes issues #74/#76 in `wabansia/lng-gg`, current Factory classification, project discovery without remembered identifiers, a deliberately slow consultation, an approval, reconnect and a Work handoff. A ten-minute human Discord call is recorded separately from automated provider/PCM probes; do not describe synthetic input as a completed human call. See the [validation record](natural-hermes-validation.md) for measured results and remaining live checks.
