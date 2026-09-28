# Local media-send lease gate, version 0.1

The attached voice session records a monotonic timestamp before activation or renewal. It derives a local output deadline from the returned `validForMs` with a two-second safety margin, independent of wall-clock skew. Speech enqueue and transfer request check this deadline at the final send boundary. A stalled process that resumes after the deadline ends its active call and leaves a started presentation unproven instead of sending late media. The session also rejects late final turns and playback acknowledgments, so they cannot create confirmation evidence after its local gate closes.

`VoiceSession.renew` extends the local gate only after the durable lease renewal succeeds and while the prior local gate is still open. It allows one renewal at a time; a delayed response cannot reopen a gate that closed while renewal was in flight. A host process must schedule renewals early enough for its normal call duration; this slice does not start that scheduler.

Memory and disposable PostgreSQL journeys simulate a process stall after durable presentation start for speech and transfer, then prove that neither provider port is called. Renewal journeys prove timely extension and reject a late renewal response or playback acknowledgment. Run `npm test` and `npm run probe:postgres`.

This is a conservative local send fence, not the final production voice scheduler. The standalone PostgreSQL ledger now uses its [database clock](LEDGER_CLOCK.md) for admitted-call transitions, while the memory adapter uses an injected deterministic clock. Real media chunks need the same local gate before each enqueue. Provider evidence and a live test call remain necessary.
