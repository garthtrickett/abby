# Attached voice-session composition, version 0.1

`AttachedVoiceSessions` holds one exact session mapping per call in the voice process. Registration requires a previously activated `VoiceSession` with an open local send gate; a second registration for the call or a scope/session mismatch is rejected. The registry supplies `PresentationDispatcher` with the matching live session. It does not recreate a session from durable state after a crash.

Registration starts a [per-session renewal loop](VOICE_LEASE_LOOP.md). The returned `ManagedVoiceSession` is the transport-facing call handle: it accepts speech and transcript events, then calls the [work loop's](VOICE_WORK_LOOP.md) commit notification after a successful final turn, playback result, or effect drain. The durable commit remains successful even if its wake-up fails; the result includes the typed wake outcome, and the independent recovery scan can deliver the pending presentation later. Ending the call stops renewal and removes the registry entry. A connected transfer also removes the entry when Abby's media role ends.

Memory and disposable PostgreSQL journeys cover scoped registration, duplicate rejection, automatic speech delivery through an affirmation and booking, lost-wake recovery, disconnect cleanup, failed playback clear, and connected-transfer cleanup. Run `npm test` and `npm run probe:postgres`.

The production host still needs authenticated ingress, transport lifecycle wiring, operational observers for renewal and worker failures, and live media callbacks. This in-process composition uses synthetic playback and does not authorize a real call or establish playback proof.
