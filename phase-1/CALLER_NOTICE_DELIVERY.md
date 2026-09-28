# Caller notice delivery, version 0.1

The call transition now commits a `notice` presentation for a caller-facing result produced by a final turn when that turn has no action-detail or transfer presentation. The same dispatcher, session lease, playback acknowledgment, interruption, and recovery rules used for other speech apply to the notice. A later caller turn supersedes an unsent notice. A duplicate turn does not create another notice.

The synthetic voice journeys cover a disabled booking setting and request-only booking and transfer. They assert the exact queued wording, no appointment write for restricted capabilities, and completed playback. The in-memory and PostgreSQL ledgers run the same journeys with isolated fixtures.

This closes a gap where `callerMessages` appeared in the call record but were never sent to the voice playback port. It does not supply live media, a model, or a Cliniko caller-facing availability result. The voice resolver cannot provide its own approved knowledge source; that requires a host-owned read before a knowledge answer can reach this path. Cliniko times still need approved timezone wording, account and route checks, and a full call journey before presentation.
