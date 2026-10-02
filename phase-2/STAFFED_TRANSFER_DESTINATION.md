# Staffed transfer destination

## Status

`SET-007` (`routing.staffedDestination`) is in progress on `codex/abby-staffed-destination-setting`, based on intake merge `cdfab65aa1ac5f00538578cebe7181b7e57320c0`. The scoped host boundary, memory/PostgreSQL setting stores, public audit, typed admin gateway, HTTP routes and lit-html picker have focused proof. Four authenticated browser journeys passed with three workers. Complete synthetic calls passed with memory and PostgreSQL storage. Reference/PostgreSQL carryover and target cutover reconciliation also have focused proof. `E2E-256` in manifest 1.67 is **syntheticImplemented**; the final source-matched release gates remain pending. This feature is not ready to publish or merge.

## Authority and scope

The route is an opaque public host reference for one tenant, clinic and location. Its normal default is unset. `CallPolicy.transferDestinationRef` selects the live transfer route; `staffDestination` and `operatorQueue` select task ownership and are independent. Number-level carrier fallback is also independent and remains `SET-008`.

`StaffedDestinationRegistry` bundles a scoped public-name catalogue and `StaffedDestinationHost(scope, destinationRef)`, which resolves the host's current route registry and permissions. Resolution must contain exactly the requested scope and reference, a nonempty host version, an explicitly supported `execute` or `requestOnly` mode, and `ready: true`. The boundary rejects unknown or malformed references, wrong scope/reference, extra patient-bearing fields, missing readiness, unsupported modes and adapter exceptions. Inputs and results are cloned. Callers cannot submit this evidence through the setting command. The catalogue has at most 50 unique references with public display names and cannot grant permission to transfer.

`captureStaffedDestination` derives the transfer mode and captures `transferDestinationVersion` from this evidence. A stored mode or fabricated host version cannot authorize live transfer. The version is admission evidence, not setting authority. Normal edits affect subsequent snapshots; previously admitted calls retain their captured route and host version. Actual dispatch uses the composed host transfer port and the existing staffed-hours, presentation and result contracts. The port receives the captured scope, call ID, session ID, policy version and optional host version; the embedding host must validate this context against its admitted route contract. Legacy trusted snapshots may omit a host version. Complete memory/PostgreSQL synthetic calls assert the exact captured context and destination. Failed transfer drains its new staff effect and immediately dispatches the truthful fallback notice; no subsequent caller turn is needed. Unproven or thrown provider outcomes close without inventing connection or replay. This evidence does not prove a real carrier transfer.

Missing route evidence cannot produce execute mode. Reference request-only fallback retains its existing host task route contract. Strict standalone PostgreSQL always keeps transfer unavailable, even when its constructor receives an execute-mode route resolver and staff-work permission; this setting does not enable patient-specific follow-up.

## Setting and audit contract

- `settings.routing.staffedDestination.change.v1` accepts `expectedVersion` and `destinationRef`, with `null` explicitly clearing the route.
- `settings.routing.staffedDestination.audit.v1` accepts an optional nonnegative safe-integer `afterVersion`.
- `settings.routing.staffedDestination.options.v1` returns the scoped host catalogue with public display names.
- All three commands are clinic-admin only and bind location and audit actor to the trusted gateway identity. Caller-supplied scope, actor, mode or readiness fields are rejected.
- Route, booking, cancellation, rescheduling, hours and other location edits share the location policy version. Route validation may await the host; the store rechecks this version before committing. PostgreSQL serializes on the same version-zero location row used by existing settings.
- Clearing remains available when the previous host route is no longer ready. Invalid or failed validation leaves the setting and audit unchanged.
- Audit entries contain version, destination reference or null, previous reference or null, actor and change time. Pages contain at most 50 route entries; unrelated edits are excluded, so version gaps are expected.
- A save may commit before its reply is lost. The gateway reports an unknown outcome; the picker reads current state rather than replaying its stale command. Failed reread locks settings editing until reload verifies the scope and version. Clear remains available if the saved host route has been withdrawn. The picker uses public display names; opaque references are carried in control values.

## PostgreSQL and privacy

Migration 038 adds `previous_staffed_destination_ref` and the `staffedDestination` change kind to `clinic_settings`. It preserves the existing change-kind constraint. Rollback refuses recorded route history, including after a clear. The intake rollback test now targets migration 036 explicitly so a newer migration cannot replace its intended refusal proof.

The adapter uses actual Kanel/Kanel-Kysely generated types. The small `PostgresStaffedDestinationSettingStore` owns host preflight, shared location CAS and route audit; the enclosing policy store supplies its existing privacy codec. Minimal policy JSON stores the public route reference and existing public settings. It stores no host permission proof or captured host version. Other location edits preserve the reference, and an explicit clear cannot resurrect a default route. Rich synthetic policies retain their existing fixture fields; those fields do not replace current host route evidence.

No patient, appointment, call, transcript, task or patient-linked outcome field is introduced. Standalone patient storage remains limited to scoped phone-to-Cliniko-ID links.

## Carryover and cutover

Archives include the raw public destination reference, `staffedDestination` change kind and nullable `previousStaffedDestinationRef`. A route change must have an attributed actor/time, the exact preceding reference, and no unrelated policy change. Other setting kinds must retain the route and cannot carry route audit metadata. Missing legacy route fields and audit metadata remain safe when no route change is claimed. Missing versions, malformed references, forged captured permission and incorrect previous-reference chains are rejected before import writes.

Each current and historical reference is mapped through the embedding host's `transferDestination` mapping for the exact source/target location. Minimal standalone import also requires this reviewed mapping; its disabled task destinations do not replace route mapping. Two locations may use the same source reference and receive different target references. Both reference import paths seed the mapped route audit, and PostgreSQL stores its previous reference with the original public actor/time. Booking/cancellation/rescheduling forced-disable rows preserve the route. Import keeps automation and patient actions disabled, and unproven target route permission cannot grant execution. Cleared routes stay cleared.

The durable source history and receipt retain the original archive data and mapping decisions. Before publishing a number route, target reconciliation compares the mapped destination, previous reference, audit actor/time, change kind, full policy and row counts. Altered metadata or unlisted target rows prevents publication; restoring the expected target permits publication. These are synthetic configuration cutover checks.

## Focused evidence

| Tracked check | Result |
| --- | --- |
| Scoped authority and memory CAS foundation | Typecheck and 15 focused cases passed; no failures/skips. Included existing intake, cancellation, rescheduling and clock cases. |
| PostgreSQL generation, CAS, privacy and rollback foundation | Migration up/down/up, actual Kanel generation, typecheck and 23 focused cases passed; no failures/skips. Included existing patient-setting persistence and rollback cases. |
| Gateway and manifest first run | Typecheck passed; 27 tests passed, one manifest expectation failed and three PostgreSQL composition cases skipped without a database. The expected ID list still stopped at 255. This invocation is not a passing gate. |
| Manifest correction and gateway foundation | The expectation now requires all 256 IDs. All 10 focused gateway/setting and manifest cases passed with no failures/skips; diff check passed. |
| Named catalogue and lit-html typing proof | Typecheck, 11 focused cases, dashboard bundle and diff check passed; no failures/skips. |
| Authenticated picker and uncertain-save journeys | Typecheck, 17 Node checks, dashboard bundle and four browser cases with three workers passed. No test retries or failures; diff check passed. Cases include default/set/change/clear, shared-version stale edits, role/Origin/identity rejection, active versus next-call snapshots, malformed or lost replies and failed-reread locks. |
| Complete call first proof | Typecheck passed. The unset/set/change/clear and blocked-transfer journeys passed, but the failed-transfer case showed the fallback notice was created without being queued. This invocation failed and is not a passing gate. |
| Failed notice delivery correction first proof | Typecheck and existing shared-number voice cases passed. The new failure notice was queued and played; the test incorrectly counted the separately played greeting as a failure notice. This invocation failed. The assertion now identifies the exact transfer failure notice and still requires one played notice and one transfer attempt. |
| Complete context and exact failure playback correction | All 24 memory/shared-number cases and 14 isolated PostgreSQL cases passed with no failures/skips. PostgreSQL includes existing signed urgent/closed-hours settings and the route persistence/CAS/rollback cases. New complete calls prove admission, streamed greeting/playback, PCM utterance closure, captured route context, connection/failure/unproven/throw outcomes, played failure notice, revoked host, closed/unknown hours and urgent denial. Diff check passed. |
| Restricted setup boundary | All seven Origin/manifest cases passed with no failures/skips. Restricted Cliniko setup rejects the route POST and both catalogue/audit GETs. Diff check passed. |
| Carryover first typing proof | Typecheck, manifest and diff check passed. |
| Mapped history and semantic rejection | Typecheck and all 21 isolated PostgreSQL cases passed with no failures/skips, including existing intake, minimal/archive and receipt checks. New cases prove both import modes, reference single/tenant import, resealed malformed-history denial, reviewed mapping, safe legacy absence and clear. |
| Multi-location/cutover first typing proof | Failed before test execution: fixture query literals did not satisfy generated Kanel identifier brands. The fixture now uses typed SQL for deliberate row inspection/tampering; generated types are unchanged. |
| Branded fixture correction | Typecheck passed and six cases passed, including multi-location mapping. The extra-row fixture violated the existing policy-scope database constraint; this invocation failed. The fixture now updates its embedded scope to match its synthetic location. The constraint was retained. |
| Scoped extra-row correction and final focused cutover | All seven isolated PostgreSQL cases passed with no failures/skips. Changed destination, previous reference, actor and unlisted row each prevented publication; restoration permitted publication. Existing appointment/intake receipt reconciliation also passed. Diff check passed. |

Owner-local logs, in the same order:

- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790966630255.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790967125977.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790967543597.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790967678389.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790968735060.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790969171953.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790970122884.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790970241952.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790970308851.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790970340440.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790970679715.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790970898697.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790971080941.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790971187775.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790971305466.log`

These are foundation checks. The PostgreSQL pass predates the later gateway declarations and stable evidence labels; a final source-matched release must verify the complete feature.

## Required before publication

1. Retain the passing authenticated HTTP/lit-html picker and browser proof in the final source-matched release. Restricted Cliniko setup must not expose an unsupported transfer setup route.
2. Retain the passing complete memory/PostgreSQL synthetic voice journeys in the final source-matched release: exact route and one transfer attempt, admitted versus subsequent snapshots, blocked transfer cases and truthful played failure notice. Carrier connection is represented by explicit synthetic provider evidence; real carrier proof remains pending.
3. Retain the passing reference/PostgreSQL carryover and target reconciliation proof in the final source-matched release.
4. Full local type/text/PostgreSQL/browser gates and mapped settings isolation alone and both observed parallel orders, with unchanged assertions, deadlines and retry policy; generated-type drift and diff checks; evidence recorded for the exact source before ordinary matched-head publication/merge.

Real carrier transfer, clinic-approved live destination, deployed clinic identity, speech quality and standalone patient-specific follow-up remain separate product gates.
