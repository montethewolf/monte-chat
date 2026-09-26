# Voice reliability validation

For a fresh installation, use the [README](../README.md) first. This checklist
supplements its first-call checks. Release-specific prior measurements are in
[normal Hermes validation](natural-hermes-validation.md); they do not certify
a new user's host or headset.

## Automated checks

Run `npm ci` and `npm test` in a checkout. Tests use local fake gateways and
throwaway state/databases; no Discord token or provider account is needed.
They exercise the installed Discord AudioPlayer and HLV SDK, not replacement
implementations of their buffering or protocol behavior.

## Manual live checks (operator-run)

Use a test conversation/thread and avoid requesting consequential actions.
Run only one bridge instance for the Discord application at a time.

1. Join from the Discord mobile app. Ask a question and verify the reply is audible
   in full; v8 context insertion does not guarantee a spoken "Ready." greeting.
   Verify `/join` reports listening only after both connections are ready. Test short
   replies and multi-sentence replies for missing starts or clipped endings.
2. Interrupt before a reply begins, during speech, and near its end. Verify
   playback stops and subsequent conversation does not assume you heard the
   rest. Record actual interruption latency; device/network buffering prevents
   a strict remote playback guarantee.
3. Speak, move channels mid-utterance, and speak again. Repeat rapid leave/join
   and `/leave` during a reply. Confirm no old audio reappears and input works.
4. While remaining in Discord voice, briefly interrupt gateway connectivity in
   a controlled test environment. Verify one useful operational notice, silence
   during reconnection, and exact saved-session recovery. Leave during recovery
   and verify the bridge stays detached.
5. Test an unavailable saved session. Verify its ID is retained and no fresh
   conversation is created. Use `/new-conversation` explicitly to recover and
   verify focus clears. Existing background tasks should remain unaffected.
6. Focus thread A, then B, then unfocus. Check Hermes answers a known fact from
   each selected thread through its conversation tool. Check mirror destinations.
   Cause a switch failure and verify the previous target remains selected.
7. After a Hermes routing/session fork, reconnect a focused call and verify the
   routing tip is selected. If local state is unreadable, verify the last known
   focused ID is retained instead of replaced with a new conversation.
8. Distinguish delegated Hermes dialogue from realtime-only dialogue: inspect
   the selected Hermes thread history after a tool-backed follow-up, reconnect,
   and verify that persisted follow-up remains available. Do not expect every
   voice acknowledgement or interrupted utterance to have been persisted.
9. Verify mirroring defaults off and an existing legacy `auto` setting is read
   as off. Set mirroring on and off through both `/mirror` and the CLI. Off must
   keep operational notices but suppress transcript and task-result content.
   Test unavailable text permissions: there must be no cross-channel fallback;
   `/mirror` should report undelivered notices. Mention-like transcript text
   must not notify users or roles.
10. Restart the bridge deliberately and check focus/default recovery, mirror
    mode, and absence of stale playback. Check service logs for repeated retries,
    worker failures, or undelivered-notice counts.

## Speech gating and diagnostics

Automated tests cover real native VAD with silence and an upstream speech fixture,
including reduced volume; bounded pre-roll, short blips, variable packet sizes,
packet-gap onset resets, one cancellation/commit, stale sinks, detector failure,
and response accounting across underflows. Tests never contact a live provider.

For Bluetooth/mobile validation, first listen with the mic muted, then unmute
without speaking. Neither case should produce a `user_barge_in` interruption.
Say short words such as "yes" and "no", then interrupt a longer reply. Verify the
first word is preserved and one `speech_confirmed` event precedes cancellation.
Compare Wi-Fi and mobile data. If a reply seems to restart, compare response IDs:
a new `response_started` after cancellation indicates a new generated answer;
underflow counters within one response indicate missing queued output.
Measure quiet-word recognition and interruption delay on the actual headset;
the detector's 100 ms confirmation adds onset latency and is not a guarantee
against background speech or acoustic echo. End-of-turn timeout and playback
buffering are outside this change.

## Upgrade and rollback

Before restarting into this revision, stop the old service and back up its
configured state and focus files. Keep the old checkout/package lock available.
The current service uses version 3 with a stable default discussion ID. Version-2
records are migrated on load; legacy `{sessionId}` and separate focus records are
also imported. The first legacy overwrite preserves `state.json.legacy` (or the
equivalent configured path). The old focus file is left untouched.

For release rollback, follow the [current release instructions](natural-hermes.md#deployment-and-rollback)
and use the matching gateway/SDK pair. Do not feed newer state to older software
or restore an old task-state snapshot over work accepted since the backup. The
v8-to-v7 helper preserves current task state; a rollback to older bridge selection
formats additionally needs the appropriate selection conversion. Mirror mode
remains in its separate file.

This implementation does not automatically deploy, restart services, run live
provider probes, or modify Hermes/HLV installations.
