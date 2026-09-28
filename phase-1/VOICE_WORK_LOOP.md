# In-process voice work loop, version 0.1

`VoiceWorkLoop` composes the lease-expiry monitor and durable presentation dispatcher. Each tick reads one timestamp, expires due admissions and sessions first, then scans pending presentations. Expiry wins over a stale output intent. A tick scans at most the dispatcher's bounded page, while the next tick advances its cursor. Ticks never overlap within one worker instance. The default interval is five seconds and can be configured from 250 milliseconds to one minute.

The host calls `start` when its call registry is ready and awaits `stop` during shutdown. It supplies an `onTick` observer to record failures and recovery counts. After a call-state commit that can create a pending presentation, it calls `notifyCommitted(callId, scope)` for prompt delivery. The scan handles missed notifications. The host must still own the registry, call this hook after relevant commits, and schedule lease renewal for attached sessions; this module does not create those integrations or a service process.

Memory and disposable PostgreSQL journeys cover missed notification recovery through a confirmed booking, expiry before attempted delivery, and call-specific notification. A deterministic timer test covers immediate start, one in-flight tick, interval rescheduling, and shutdown cancellation. Run `npm test` and `npm run probe:postgres`.

These journeys use synthetic media. Live STT/TTS, transport callbacks, provider transfer evidence, and number-level fallback remain separate work. The worker does not make synthetic playback evidence a production capability.
