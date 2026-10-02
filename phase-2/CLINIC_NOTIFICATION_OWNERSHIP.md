# Clinic notification ownership — SET-009

## Status

Implemented and locally release-verified on source `15817fba675efe6936f6756847ff32c793aa25ce`. The full gate passed owner settings, audit storage, migration, captured-call authority, delivery barrier/recovery, authenticated gateway/HTTP/lit-html controls, complete synthetic memory/PostgreSQL calls, carryover, embedded cutover and redacted delivery/review discovery.

The evidence below is engineering proof. Actual delivery providers and real telephone validation remain separate gates. Production login provider integration and locale/voice settings remain outside this feature.

## Product contract

- The clinic chooses exactly one owner (`host` or `abby`) for each supported notification type. Clearing stores `null`; all three types start unset at clinic version `0`.
- Initial types are booking, cancellation and rescheduling confirmation. Intake does not imply a notification or duplicate the later booking confirmation. Additional types need an explicit typed contract and their own setting-to-call evidence.
- All locations and types share one clinic notification version. Changes use compare-and-swap, return typed errors, and record kind, previous/new owner, actor and time. Location policy versions remain independent.
- Raw preferences are public clinic configuration. They contain no recipient, message, patient/appointment/call reference or delivery outcome.
- A setting cannot authorize a provider or host operation. Exact current host evidence must name the location, type, supported owner and host version, and prove that native automatic sends are suppressed on the managed write paths. A declaration permitting automatic sends is rejected.
- Unsupported, withdrawn or unset choices produce no effective binding and no Abby managed notification effect. An active call retains its captured binding. Ordinary changes affect subsequent calls. Separate emergency stop fences unsent effects; this setting does not reassign active intents.
- Strict standalone Cliniko never receives an executable notification binding, even if a factory or injected registry claims one. Its public preferences may be inspected or cleared; patient-specific notification work remains unavailable.

## Interfaces and call path

`notification-policy.ts` owns stable types, validation, host preflight and admission capture. `ClinicNotificationSettingStore` owns clinic preference CAS and audit paging. `MemoryPolicyStore` and `PostgresPolicyStore` compose preferences into snapshots; persisted location policy must not supply a competing preference or captured host version.

`NotificationRegistry.resolve(location, kind, signal)` returns an exact scoped declaration with `nativeDelivery: managedOnly`. It is host code, never a setting payload. Independent configured kinds resolve concurrently. Each lookup has a 1.5-second deadline and abort signal; a throw, timeout or invalid reply becomes `readinessFailed` for `notificationOwner`.

SAM copies the binding into a `NotificationDirective` on the confirmed appointment mutation before dispatch. The directive includes a stable scope/call/action/type notification key and the captured settings/host versions. The write adapter must suppress native delivery and acknowledge that exact directive in a committed receipt or an exact-commit reconciliation observation.

After proven commit, SAM creates at most one intent with the directive, committed host reference, call/action reference and policy version. An absent, changed or expanded suppression acknowledgement produces a review-required notification effect and no notification dispatch. It does not erase the proven appointment result. A rejected or uncertain appointment cannot trigger notification delivery; exact reconciliation may queue it once after proving commit and suppression.

`notification-effects.ts` owns intent creation and notification transitions. `notification-dispatch.ts` uses only the persisted intent. `NotificationHost.dispatchNotification(intent, signal)` must route by its captured owner and honor its captured host version, scope and idempotency key. The embedding host may compose its native sender or an Abby sender into this interface. Neither the worker nor recovery consults live owner settings. The host resolves recipient and approved content from its committed reference; provider payloads are not SAM state.

The worker persists `possiblySent` before the send. Outcomes are `sent` with a delivery reference, `definitiveUnsent`, or `unknown`; each echoes key, owner and host version. Invalid replies and post-barrier exceptions are unknown. A missing sender cancels an unsent intent with a typed reason.

Unknown delivery creates an observation effect. `observeNotification` uses the original intent and never sends. Process loss at the barrier follows the same path after the existing 60-second possible-send recovery delay. Persistently unknown delivery becomes review-required at the 24-hour deadline. There is no blind send retry and no success claim inferred from an appointment receipt.

Foreground and background workers share the existing per-call effect lease and storage fencing. Emergency stop blocks a pending notification at the atomic send barrier, includes already possibly-sent/uncertain notification effects in its in-flight report, and allows observation of those effects.

## Storage and carryover

Migration `039_clinic_notification_settings` creates one append-only clinic history with a version-zero locking row. The database constrains the exact three owner keys, owner values, public audit fields and version-zero shape. Recorded history blocks destructive migration rollback. PostgreSQL types are generated by Kanel and kanel-kysely from the migrated schema, then consumed by Kysely stores.

Only public preferences and audit belong in configuration archives. Captured bindings, host versions, intent references, recipients and delivery outcomes must not be exported as configuration. Reference and PostgreSQL imports preserve source history and append a separate target clear for each non-null owner, using one clinic history across locations. Fresh target host evidence is required before a future owner edit can become effective. The new table uses the existing tenant write and truncate freeze guards. Embedded cutover reconciliation compares the complete imported history, clear actors/timestamps and all tenant rows before number publication. Legacy absence defaults unset. Minimal and rich import paths have focused proof; the new complete number-publication journey uses the synthetic embedded composition, not a minimal standalone cutover claim.

Standalone patient-data restrictions remain authoritative: migration 039 holds public configuration only. Rich notification intents and effect recovery are available solely in an authorized embedded host or the explicitly unsafe synthetic reference ledger. They are not an allowance to persist patient-specific standalone data.

## Verification required for release

1. Memory and PostgreSQL adapter agreement: default, set/change/clear, cross-kind/location CAS, invalid/stale input, malformed/foreign/withdrawn declarations, audit order/paging, reconnect and public storage shape.
2. Host preflight deadline, abort, concurrent resolution and post-await CAS recheck. Invalid values cannot append history.
3. Both owners and all three action types: exact confirmation playback, caller affirmation, captured directive, proven appointment commit/suppression, one notification, exact delivery observation. Unconfirmed/rejected/uncertain appointment, default/unset and unsupported notifications cannot send.
4. Active call versus next call across owner changes and clears. Sender sees the captured owner and version, with no live-setting lookup. Unknown acknowledgement recovery does not duplicate configuration writes.
5. Notification uncertainty: exceptions, provider deadline, malformed/wrong-owner/key/version replies, definitive unsent, process loss at barrier, observation until deadline, terminal review state and concurrent recovery. Appointment truth remains independent of notification success.
6. Admin scope, role, exact Origin, shared version conflicts and lost/malformed save reply recovery through the actual server and lit-html UI. Strict Cliniko setup cannot expose an unsupported notification mutation route.
7. Export/import/cutover proof, scoped history, target clear, sealed malformed history denial, legacy imports and replay stability.
8. Scenario manifest records synthetic versus real-provider evidence accurately. Mapped files run alone and in both parallel orders, with existing deadlines/retry settings unchanged and zero mapped skips. Full type/text/PostgreSQL/browser/release evidence is recorded before publication.

## Evidence so far

- Actual migration up/down/up, Kanel generation and initial typecheck passed in tracked job `Abby notification clinic schema actual Kanel generation and initial typing`.
- First foundation attempt stopped at two fixture excess-property errors: location literals were passed to a clinic-only read/audit interface. The fixtures now pass their bound location variables without changing the clinic store contract.
- Corrected foundation gate passed typecheck plus **33 focused checks, zero skips**: memory notification policy/store, PostgreSQL notification store and reference composition contracts. Tracked job: `Abby notification clinic scope fixture correction and focused foundation proof`.
- First delivery typing gate caught grouped discriminant narrowing and explicit `undefined` optional receipt fields. The action union now has individual variants and receipts omit absent optional values.
- The next memory gate caught two rescheduling fixture errors: the proposed replacement offer had the original appointment's start time. Core correctly rejected those requests. Correcting the offer to a distinct time retained that guard. The corrected notification-only memory gate passed **31 checks, zero skips** before the additional negative/deadline/corruption cases were added.
- The final focused disposable PostgreSQL gate passed typecheck and **87 checks, zero skips**, including the added notification cases, existing booking/recovery/reference-composition regressions, and a populated schema upgrade with destructive rollback refusal. Command: `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && npm run typecheck && ABBY_LEDGER=postgres node --test --test-concurrency=4 test/text/notification-policy.test.ts test/text/notification-effects.test.ts test/storage/postgres-clinic-notification-settings.test.ts test/text/booking.test.ts test/text/effect-recovery.test.ts test/composition/reference.test.ts && git diff --check'`. Tracked job: `Abby notification populated upgrade and delivery barrier final focused PostgreSQL proof`.
- Six authenticated browser journeys passed with three workers. Initial failure expected HTTP 409 for unavailable host evidence; the server's established typed readiness contract is HTTP 400. The corrected test verifies the exact `readinessFailed` body and no history write. Job: `Abby notification sender readiness HTTP contract correction browser proof`.
- Gateway, PostgreSQL setting and restarted restricted Cliniko admin tests passed **15 checks, zero skips**. All three notification endpoints remain 404 in that standalone server. Job: `Abby notification admin PostgreSQL and strict Cliniko endpoint boundary proof`.
- Complete synthetic voice journeys passed **19 checks, zero skips**, covering both memory/PostgreSQL adapters, both owners, all three appointment actions, exact confirmation playback, active/future policy, no default/withdrawn sender, unknown delivery observation and missing suppression proof. Job: `Abby notification voice registry typed evidence correction proof`.
- Carryover and setting regressions passed **21 checks, zero skips** after correcting archive fixture mode, preserving the declared target tenant and asserting the duplicate-record envelope rejection. Source freeze rejects API edits and raw mutations; unlisted source clinics block export. Job: `Abby notification explicit target clears and carryover fixture authority correction proof`.
- Embedded number cutover and carryover regressions passed **9 checks, zero skips**. Wrong target clear metadata and unlisted notification rows block publication; restored exact history succeeds. The initial minimal composition fixture was rejected at target reconciliation; the corrected complete journey uses the existing synthetic embedded cutover composition. No standalone minimal publication proof is claimed. Job: `Abby notification embedded cutover composition correction focused proof`.
- Manifest 1.68 registers `E2E-257`, the three typed notification commands and `notifications.owner`; full carrier evidence stays planned. The registered checkpoint passed actual Kanel regeneration without drift, typecheck, **80 Node checks and six browser journeys, zero skips**. Job: `Abby notification registered browser voice carryover and real Kanel focused checkpoint`.
- Final review normalized accepted UTC timestamp spellings across adapters and added raw truncate-fence denial. Typecheck and **eight checks, zero skips** passed. Job: `Abby notification timestamp canonicalization and freeze truncate final focused proof`. The complete release evidence is recorded below.

## Redacted delivery review

The scoped call-review projection shows each original notification once, with only kind, captured owner, status, exact outcome and a fixed public blocked reason. It excludes recipients, message content, patient/appointment/action references, idempotency keys and provider identifiers. A proven appointment remains committed independently of notification delivery. Missing suppression acknowledgment shows review required; unknown delivery never becomes a sent claim. Invalid stored intent, observation or status combinations return `storageCorrupt`.

The scoped call-outcome report includes separate notification counts so staff can discover unconfirmed and review-required deliveries without knowing a call ID. Counts describe returned rows and accumulate across loaded pages; reconcile effects are not counted twice. Browser validation rejects extra private fields, contradictory status/outcome combinations and totals inconsistent with rows. A failed report refresh clears the previous report rather than showing stale delivery status as current. There is no manual notification resend command.

Focused evidence: typecheck and **34 Node checks, zero skips**, passed in `Abby notification safe outcome refresh and paged review discovery focused proof`; its browser failure was an incorrect pagination button label. The corrected browser-only gate passed **10 journeys, zero skips**, in `Abby notification existing outcome pagination label correction browser proof`. These cover authenticated ownership edits, real runtime commit/send/observation, suppression review, staff and forged-scope access, redaction canaries, malformed replies and discovery on a second outcomes page. Earlier browser failures exposed an invalid test dispatch of a held effect, an extraction whitespace error and stale report display after malformed refresh; each was corrected without changing effect guards, retries, deadlines or worker counts. The complete release evidence is recorded below.

## Complete local release gate — 2026-10-02

Implementation source: `15817fba675efe6936f6756847ff32c793aa25ce`. Tracked job `Abby notification source 15817fb full local and mapped isolation release` completed in **34m38s, exit 0**, inside an escaped user scope. No source changed during the gate; subsequent release-evidence edits are Markdown only.

| Gate | Result |
| --- | --- |
| `npm test` | Typecheck and 662 passing cases; 34 PostgreSQL-only skips and one opt-in live Cliniko skip; zero failures |
| Disposable PostgreSQL migration and `npm run db:generate` | Passed; actual Kanel/kanel-kysely generated types had no drift |
| `ABBY_LEDGER=postgres npm run test:postgres` | 1,097 passing cases, zero failures; one opt-in live Cliniko skip |
| `npm run test:browser` | 59 passing journeys, zero skips |
| `npm run test:settings-isolation` | 18 selected cases passed in both parallel orders across six voice files |
| `npm run test:settings-isolation:postgres` | 329 mapped Node cases across 46 files and 46 mapped browser journeys across nine files, alone and in both parallel orders; zero failures or skips |
| `git diff --check` | Passed |

The full test commands also passed their ordered-runner coordinator check. The manifest-wide sweep separately passed both Node and browser coordinators and observed actual overlap with four Node workers and three browser workers. No retry, deadline, skip policy or worker count was weakened. PostgreSQL migration/generation used `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && npm run db:generate && git diff --exit-code -- src/storage/generated && ABBY_LEDGER=postgres npm run test:postgres'`.

The product owner has authorized merge after local validation without waiting for GitHub CI. This evidence does not assert a GitHub CI pass, real notification delivery, carrier quality or clinic activation.
