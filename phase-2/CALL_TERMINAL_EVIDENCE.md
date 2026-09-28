# Call terminal evidence, version 0.1

An ended call now stores one typed terminal reason and timestamp in its durable call state. The reducer records `admissionExpired`, `leaseExpired`, `transferConnected`, and `transferUnproven` from the matching committed transition. The voice session records `mediaFailure` after playback clear cannot be proven, or `localLeaseClosed` when its conservative output gate closes. An ordinary `end` records `sessionClosed`; a transport may explicitly pass `callerDisconnected` only after it has authenticated and classified that disconnect event.

The reason is written with the lifecycle transition and appears in redacted call review and the scoped outcome report. The PostgreSQL decoder validates the shape, while older ended records without a reason remain readable. Synthetic memory, PostgreSQL, and browser journeys cover the reason and report path. These tests do not prove that a future live telephony adapter classifies its disconnect events correctly.

`callerDisconnected` counts a transport-observed hangup. It does not by itself prove abandonment: the caller may have completed an informational request, made a staff request, or transferred after useful service. Release-grade abandonment reporting needs a product definition, service-completion evidence, and real transport E2E cases before it can be labeled as such.
