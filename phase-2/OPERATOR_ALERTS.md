# Durable operator alerts, version 0.1

`StaffAlertMonitor` scans one configured clinic location in bounded staff-queue pages. It stages one stable outbox effect per task and condition: `overdue` when an unresolved item passes its due time, and `needsReview` when task delivery or a staff change requires review. The reducer rechecks the current item and the operator destination before committing the intent. If the item resolves before the send barrier, the pending alert is canceled.

`EffectWorker` marks an alert possibly sent before calling `OperatorAlertHost.sendAlert`. A delivered receipt marks the task's alert state delivered. A definitive failure remains visible as failed; a lost or uncertain response creates a separate exact-key reconciliation intent. After a crash, recovery never sends that original alert again. Exact delivery, definitive non-delivery, and still-unknown outcomes update the task's alert state without inventing success. The scoped staff queue, agent command, and `lit-html` dashboard show that state without patient or spoken content. The reference host stores keyed alert receipts and deduplicates an identical command.

The local demo runs alert staging before each periodic effect-recovery pass. An embedded or production host must start that loop for each active location, implement the operator alert port with an approved destination and authoritative key lookup, and route failed or unproven delivery through an independent operational channel. If the port is absent, the pending intent remains durable and the worker reports failure. The synthetic reference host is not a real notification channel; D-07 and the live FR-19 readiness gate remain open.

Memory and PostgreSQL journeys cover overdue and review-required alerts, one logical delivery across repeats, crash-after-send reconciliation, failed delivery, obsolete alert cancellation, scope isolation, and loop ordering. A browser journey checks the staff-facing delivery status through the shared command path.

The standalone aggregate health sender now has an optional [durable operational
alert receiver](../deploy/voice/OPS_ALERT_RECEIVER.md). It accepts only
authenticated configured clinic/day/counter/threshold alerts, persists no
patient or call identifiers, and deduplicates across separate processes and
actual receiver loss. A compiled owner reader recovers the scoped aggregate
inbox. This is an infrastructure health channel; it does not replace Cliniko's
patient-specific review queue, implement this reference task-alert port, page a
human or prove duty ownership. Those live gap-3 requirements remain open.
