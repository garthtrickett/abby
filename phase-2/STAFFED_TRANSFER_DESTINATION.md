# Staffed transfer destination

## Status

`SET-007` (`routing.staffedDestination`) is in progress on `codex/abby-staffed-destination-setting`, based on intake merge `cdfab65aa1ac5f00538578cebe7181b7e57320c0`. The scoped host boundary, memory/PostgreSQL setting stores, public audit and typed admin gateway have focused proof. `E2E-256` in manifest 1.67 is **textImplemented**; its browser, complete voice, carryover and release gates remain pending. This feature is not ready to publish or merge.

## Authority and scope

The route is an opaque public host reference for one tenant, clinic and location. Its normal default is unset. `CallPolicy.transferDestinationRef` selects the live transfer route; `staffDestination` and `operatorQueue` select task ownership and are independent. Number-level carrier fallback is also independent and remains `SET-008`.

`StaffedDestinationHost(scope, destinationRef)` resolves the host's current route registry and permissions. Success must contain exactly the requested scope and reference, a nonempty host version, an explicitly supported `execute` or `requestOnly` mode, and `ready: true`. The boundary rejects unknown or malformed references, wrong scope/reference, extra patient-bearing fields, missing readiness, unsupported modes and adapter exceptions. Inputs and results are cloned. Callers cannot submit this evidence through the setting command.

`captureStaffedDestination` derives the transfer mode and captures `transferDestinationVersion` from this evidence. A stored mode or fabricated host version cannot authorize live transfer. The version is admission evidence, not setting authority. Normal edits affect subsequent snapshots; previously admitted calls retain their captured route and host version. Actual dispatch still uses the composed host transfer port and the existing staffed-hours, presentation and result contracts. This foundation does not prove a played transfer.

Missing route evidence cannot produce execute mode. Reference request-only fallback retains its existing host task route contract. Strict standalone PostgreSQL always keeps transfer unavailable, even when its constructor receives an execute-mode route resolver and staff-work permission; this setting does not enable patient-specific follow-up.

## Setting and audit contract

- `settings.routing.staffedDestination.change.v1` accepts `expectedVersion` and `destinationRef`, with `null` explicitly clearing the route.
- `settings.routing.staffedDestination.audit.v1` accepts an optional nonnegative safe-integer `afterVersion`.
- Both commands are clinic-admin only and bind location and audit actor to the trusted gateway identity. Caller-supplied scope, actor, mode or readiness fields are rejected.
- Route, booking, cancellation, rescheduling, hours and other location edits share the location policy version. Route validation may await the host; the store rechecks this version before committing. PostgreSQL serializes on the same version-zero location row used by existing settings.
- Clearing remains available when the previous host route is no longer ready. Invalid or failed validation leaves the setting and audit unchanged.
- Audit entries contain version, destination reference or null, previous reference or null, actor and change time. Pages contain at most 50 route entries; unrelated edits are excluded, so version gaps are expected.
- A save may commit before its reply is lost. The gateway reports an unknown outcome; a caller must read current state rather than replay its stale command. Browser recovery is still pending.

## PostgreSQL and privacy

Migration 038 adds `previous_staffed_destination_ref` and the `staffedDestination` change kind to `clinic_settings`. It preserves the existing change-kind constraint. Rollback refuses recorded route history, including after a clear. The intake rollback test now targets migration 036 explicitly so a newer migration cannot replace its intended refusal proof.

The adapter uses actual Kanel/Kanel-Kysely generated types. The small `PostgresStaffedDestinationSettingStore` owns host preflight, shared location CAS and route audit; the enclosing policy store supplies its existing privacy codec. Minimal policy JSON stores the public route reference and existing public settings. It stores no host permission proof or captured host version. Other location edits preserve the reference, and an explicit clear cannot resurrect a default route. Rich synthetic policies retain their existing fixture fields; those fields do not replace current host route evidence.

No patient, appointment, call, transcript, task or patient-linked outcome field is introduced. Standalone patient storage remains limited to scoped phone-to-Cliniko-ID links.

## Focused evidence

| Tracked check | Result |
| --- | --- |
| Scoped authority and memory CAS foundation | Typecheck and 15 focused cases passed; no failures/skips. Included existing intake, cancellation, rescheduling and clock cases. |
| PostgreSQL generation, CAS, privacy and rollback foundation | Migration up/down/up, actual Kanel generation, typecheck and 23 focused cases passed; no failures/skips. Included existing patient-setting persistence and rollback cases. |
| Gateway and manifest first run | Typecheck passed; 27 tests passed, one manifest expectation failed and three PostgreSQL composition cases skipped without a database. The expected ID list still stopped at 255. This invocation is not a passing gate. |
| Manifest correction and gateway foundation | The expectation now requires all 256 IDs. All 10 focused gateway/setting and manifest cases passed with no failures/skips; diff check passed. |

Owner-local logs, in the same order:

- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790966630255.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790967125977.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790967543597.log`
- `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790967678389.log`

These are foundation checks. The PostgreSQL pass predates the later gateway declarations and stable evidence labels; a final source-matched release must verify the complete feature.

## Required before publication

1. Authenticated HTTP route and standalone lit-html control using the host's scoped catalogue of public destination names, with opaque references carried by the control rather than entered by the user. Prove default/set/change/clear, invalid/stale/role/Origin, reload, raw versus effective status, active-call versus next-call state, and uncertain-save reread/lock recovery. Restricted Cliniko setup must not expose an unsupported transfer setup route.
2. Complete memory/PostgreSQL synthetic voice journeys: exact route, queued/played transfer behavior and one attempt; admitted old route versus subsequent changed/cleared route; unsupported host, closed/unknown staffed hours, failed/uncertain transfer and truthful fallback without claiming connection or staff delivery.
3. Reference and PostgreSQL carryover: map current and historical route references, preserve the audit, keep unproven target execution disabled, accept safe legacy absence, and reject malformed history or target reconciliation before cutover.
4. Full local type/text/PostgreSQL/browser gates and mapped settings isolation alone and both observed parallel orders, with unchanged assertions, deadlines and retry policy; generated-type drift and diff checks; evidence recorded for the exact source before ordinary matched-head publication/merge.

Real carrier transfer, clinic-approved live destination, deployed clinic identity, speech quality and standalone patient-specific follow-up remain separate product gates.
