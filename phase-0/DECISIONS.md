# Phase 0 product decisions

**Status:** Proposed defaults for review. None of these rows is an approved clinic or product decision.

| Decision ID | Question | Proposed default pending approval | Owner and deadline |
| --- | --- | --- | --- |
| D-01 | How is an existing caller verified before appointment details or changes? | Phone match produces candidates only; use clinic-approved proof with a bounded attempt count, then staff handoff. | Product and clinic owner; before patient lookup automation. |
| D-02 | Which action result may Abby describe as confirmed? | Only an exact committed host receipt; uncertain writes are called pending and assigned reconciliation or staff work. | Product; before the first action E2E. |
| D-03 | What may a first-time caller complete automatically? | Staff request until approved intake consent, duplicate check, stable patient ref, and safe write recovery are proven. | Product and clinic owner; before intake automation. |
| D-04 | Can Abby reschedule an appointment? | Staff request until a host-native or atomic operation and exact recovery are proven. | Product; before rescheduling automation. |
| D-05 | Who owns confirmations and reminders? | One host-approved owner per notification kind, captured for each call; no duplicate send. | Product and clinic owner; before notification implementation. |
| D-06 | When may audio or transcript be retained? | Persistent capture off until a bound location and durable policy/consent outcome allow it. | Product and clinic owner; before retained-media implementation. |
| D-07 | Where does failed or overdue staff work go? | A required operator review queue is configured before automation; failed task delivery never counts as handoff. | Product and clinic owner; before staff-task implementation. |
| D-08 | Which market, locale, and quality thresholds govern the first pilot? | Use existing clinic markets; declare sample size, critical failures, latency and language thresholds before pilot traffic. | Product; before pilot design approval. |
| D-09 | Which telephony route handles failed intake or voice startup? | A provider-owned number fallback, tested while Abby is unavailable; block live-call readiness until proven. | Product and voice engineering; before live routing. |

An engineering proposal remains a proposal until its owner records the decision and evidence. A changed answer updates the PRD, technical contract, scenario expectation, and support matrix where affected.
