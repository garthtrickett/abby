# Signed outbound status delivery

Optional trusted-host engineering, inactive by default. A provider callback can
arrive after Abby loses its local conversation or a native write response. This
module combines existing restrictive stop recovery with completed-notification
retention. It acknowledges delivery only when the applicable native truth is
retained. It does not release either call or contact capacity, start a session,
make a clinical action, or infer no-stop from missing speech.

## One signed request and one budget

`twilioOutboundStatusReceiver` uses the existing Twilio ingress. The ingress
checks its current authority and the real signed request; the captured delivery
module reauthenticates the raw body with the same actual runtime. Forged requests
are refused. Queued, ringing and in-progress events consume no native purpose.

`TwilioOutboundStatusDelivery.create` captures the existing stop and notification
owners once. Their runtime, clinic scope, physical API credential and physical
request-budget object must agree. The notification family must differ from the
request, attempt, contact and speech-report families. There is one cumulative
allowance of at most 180 native requests, in addition to the real shared
API-user budget. It cannot be reset between owners. One whole-operation deadline
(five seconds by default, at most ten) aborts both stages and late continuations.

Restrictive stop recovery runs first. An authenticated producer report can
authorize its independently permitted DNC decision under the existing approved
policy. If that decision is uncertain, the response stays retryable and no later
notification is appended. Once retained, a DNC decision survives a subsequent
notification failure. Authentic negative terminal statuses retain the existing
positive-stop behavior without creating completed provenance.

For completed status, independently permitted absence of a positive report may
leave contact unknown while a retained notification is acknowledged. Absence is
never a complete no-stop observation. Denied or incomplete report reads cannot
be bypassed by notification permission.

## Retention and response loss

The original explicit notification binding, dedicated native family, verifier
key, permanent derived purpose and current source/write grants are unchanged.
The producer and delivery recovery share a private approval reader; that reader
grants no effect by itself. The native mutation still claims its real SQL
exclusion before its only possible POST.

Known native acknowledgement or independently permitted exact cold native
discovery establishes notification retention. Cold discovery matches the sealed
original attempt, provider account and physical call; it does not need a lost
local notification reference. Archived/closed history, original rereads and
independent collection/decoded/original-record grants remain required. A spent
purpose with no independently retained result remains unknown and cannot POST
again. Changing the key, source or family cannot mint a new purpose.

HTTP 204 means the applicable delivery work was retained. HTTP 503 preserves an
unresolved delivery; forged authentication returns 403. Neither response proves
carrier end, participant identity, complete speech coverage, an appointment,
payment, consent or contact settlement. The separate notification-capacity
recovery module still needs its own complete provider/source evidence.

## Current local qualification, 21 October 2026

- Current source controls pass 135/135 (work 1792543646043): actual signed HTTP,
  positive-first recovery, lost acknowledgements, cold duplicates, shared
  allowance, current authority, deadlines and prior positive/notification/ingress
  contracts. No skips or cancellations.
- Full strict TypeScript and the actual serving build pass (1792544441488),
  producing 699 outputs. A later serving-project typecheck/build
  (1792545466704) corrects only a synthetic fixture's live getter; exactly that
  fixture output changes and all production bytes remain identical. This later
  build is not described as a second whole standalone strict check.
- Ten actual emitted callback/PostgreSQL cases pass (1792546181709), including
  real original carrier dispatch, signed HTTP/WSS, played greeting, endpointed
  synthetic ASR, retained native report, DNC/notification acknowledgement loss,
  signature/source/quota denial and parallel callbacks. Both SQL holds remain.
- The 42 existing emitted notification, terminal-speech, positive-stop and
  finality/process-loss cases pass on the combined graph (1792546181848).
- New nonemitted process/restore drivers pass their affected strict graph
  (1792547863640). Actual emitted HTTP recovery passes four SIGKILL cases before
  and after each DNC/notification native write; an independent child recaptures
  the nominal approved policy and owns its SQL connection/budget. It receives
  clinic/runtime configuration at boot and the original signed provider request
  through HTTP after listening, without lost local session/report/notification
  handles. Definite signal termination, empty working directories and empty
  stdout/stderr are checked. Stored results recover; unretained uncertainty
  cannot repeat a POST. Process-case grants are held current synthetic remote
  grants; these cases do not independently prove grant revocation.
- A separate full logical-backup/restore case uses a fresh runtime, freshly
  captured policy, restored real SQL barriers and restored physical budget.
  Repeated delivery discovers native truth without changing either effect or
  hold. Together with the existing capacity-purpose restore case, this last
  cohort passes 6/6 (1792547986151, 1m58s, Node peak 196,464,640 B/1 GiB and
  separate PostgreSQL peak 128,262,144 B/512 MiB).

All database cohorts retain legitimate unrelated phone/index/staged/effect rows,
scan every column and inspect the complete unfiltered raw backup for private
material. Native notes, original URLs/body, credentials, MAC/key/context, phone,
call/session identifiers and actual recognized text stay out of local SQL.
Source, dependency and actual 699-artifact hashes remain pinned; disposable
databases are cleaned. CPU is bounded, swap disabled and OOM/high/max counters
remain zero. Remote carrier/native/acoustic services and clinic grants are
synthetic. The failed first accepted-case fixture and failed driver typecheck
remain historical evidence, followed by their owning corrections.

Normally merged PR #575/main ca3bffb is integrated with every qualified
source/runtime input and all 699 artifact bytes unchanged. Facts/scenarios and
source/dependency/cleanup guards are rechecked; no duplicate runtime build or SQL
pass is claimed. This remains local engineering qualification pending its own
exact-head publication/cloud checks and normal review. Actual parent-main CI is
independently monitored, never inferred from branch checks. Default hosting configuration is unchanged. Complete
no-stop/private/all-ASR coverage, actual clinic/provider/source/restore and
acoustic acceptance, gap 13 implementation and the full execution-order goal
remain open. No deployment or live-call authorization is inferred.

## Consistent full restore snapshot, 22 October 2026

Actual normal main 7916d8d's PostgreSQL job 119581758863 failed one full-restore assertion, with 6,601 passed/one failed/one skipped. Its type, text and browser jobs passed. The complete failed run and raw four-job logs are preserved separately from PR #581's eight successful feature-head checks. The restored full effect table was compared with a later complete live table while another status-process test added legitimate opaque claims. Missing rows belonged to that unrelated concurrent tenant. This is no native patient-action or memory failure, and the historical main run is not green.

On exact unchanged 2047802 source/722 outputs, a diagnostic preload lets the actual unfiltered pg_dump finish and then invokes a separate real PostgresOutboundEffectBarrier writer before the old live-baseline query. Work 1792636295262 reproduces the exact assertion with one failed case; it remains RED diagnostic evidence, not qualification. The same controlled writer with the corrected snapshot witness passes 1/1, work 1792636612322, separately from normal cases.

The owning SQL witness now holds a PostgreSQL repeatable-read transaction open, exports its snapshot, reads all effect/hold columns with stable ordering and supplies that exact snapshot to the full pg_dump. A separate real SQL owner creates legitimate opaque effect and capacity records before and after the export point. Assertions establish that the earlier independent rows are included, later live rows exist, and the complete imported tables equal the exported baseline before and after cold native recovery. No unrelated table/tenant is filtered out or deleted to force equality; snapshots, complete exports and every-column/raw/COPY/JSON privacy checks retain their distinct jobs. Existing native receipts, no-replay, held capacity/contact, concurrency 4, native 180 and 60s test deadline remain unchanged.

The first correction passed runtime checks but whole strict rejected raw unknown rows in the new membership assertions; that exit2 and exact source are preserved. The narrow refinement uses typed Kysely selectAll reads, preserving every column and ordering. Current whole strict1792636813699 passes; all 722 existing serving outputs remain byte-exact, with no new emission needed for this non-emitted witness/helper change. Current normal entrypoints `test/storage/postgres-twilio-outbound-status-process.test.ts` and `test/storage/postgres-twilio-outbound-status-restore.test.ts` run with `ABBY_LEDGER=postgres node scripts/test-node.mjs --test --test-concurrency=4` and pass5/5, work 1792636825883. Unrelated legitimate phone-index/staged-scan/effect rows remain, the complete backups stay unfiltered, and owned database/container/slice cleanup passes. Node peak 264,724,480 B/512 MiB and whole strict 1,685,155,840 B/2 GiB; Swap0 and OOM/high/max0 remain.

The class follow-up's 123 source/27 SQL evidence remains separate: those source dependencies and all 722 serving bytes are unchanged. No newly rerun 32-case graph, real restore/provider/clinic acceptance or deployment is inferred. Current final facts/review, same PR #582 new-head publication/cloud and ordinary corrected merge remain required. A failed historical parent's main check is never relabelled or silently treated as current green.

## Subsequent independent financial witness correction, 22 October 2026

Same PR #582 combines the separately qualified class memo follow-up (123 source controls/27 signed SQL cases) with two owning test-fixture corrections. Actual main 7916d8d failed one full-restore snapshot comparison; its other three jobs passed. Earlier feature head 2047802 later passed seven cloud jobs but failed its concurrent financial class-expiry witness. Complete raw logs for both failures remain archived. Controlled witnesses reproduce each cause: comparing a backup with later live rows, and rejecting an in-flight active attendance query after a competing cancellation. The snapshot correction retains five qualified process/restore cases. The current financial correction passes 113 affected source controls and 21 normal SQL cases; strict TypeScript and emission commands both pass and all 722 serving files remain exact. An incorrect expected-output guard failed separately and is preserved, with independent output verification and no compiler rerun. Class 123/27 and restore five remain separately scoped through unchanged source dependencies and serving bytes; counts are not added into a fresh combined total. Current exact-head review, publication, new cloud checks, ordinary corrected merge and actual-main verification remain required. Clinic/provider acceptance, activation and the full thirteen-gap roadmap remain open. Staff review for unclear outbound audio is separate unpublished work; future calls stay blocked. See [the concurrent financial fixture correction](STRIPE_FINANCIAL_CONTRACT.md#concurrent-native-fixture-correction-22-october-2026). The preceding snapshot and memo evidence retains its original scope; no clinical or contact capability changes in this correction.

## Isolated outbound verification privacy witnesses, 22 October 2026

Previous PR #582 head 973c9b6 passed seven cloud jobs, but its pull-request PostgreSQL job 119621107651 failed the outgoing financial `peerQuota` case: 6,620 passed, one failed, one skipped. The full scanner reported verification-code canary `follow_up_7_0` in `admin_sign_in_rate_limits.key_digest`. Its push PostgreSQL job passed. All eight complete raw logs retain those actual conclusions; this is independent of the earlier snapshot and financial attendance-fixture failures.

A controlled original-case run reproduces the exact scanner location using real authentication digest derivation and real challenge issuance: an unrelated synthetic administrative digest exists before the code is issued and remains unchanged afterwards. No literal cloud digest was logged, so the reproduction proves the collision mechanism rather than identifying that unobserved value. The corrected controlled run passes with an independently selected clock-safe digest/code pair. That pair differs from the RED run and is not presented as a literal matched-pair result. Neither diagnostic is added to normal qualification counts.

The four existing outbound clinical rescheduling, signed verification, cancellation and financial-follow-up suites now migrate one owned database per case inside their already admitted disposable PostgreSQL server. Actual challenge/budget/barrier work and its independent peer connection share that database. Full-column canary scans and complete raw backups target the same database. The shared administrative application database is left untouched; authentication fields, hashes and short codes are neither omitted nor exempted. An isolated negative probe writes the actual synthetic code into the authentication digest column and requires the unchanged scanner to detect it. Each real case preserves complete unrelated phone-index, staged-scan and opaque-effect rows; cleanup verifies them and drops only that case's databases, retaining both original and cleanup failures.

Normal work 1792648592933 passes all 13 unchanged scenarios with four-file concurrency, no skips or cancellations, while a complete before/after comparison retains every shared application table and all 401 independently seeded legitimate authentication digest rows. Node peak is 563,130,368 bytes and PostgreSQL peak 248,041,472 bytes, with no OOM events; cleanup is verified. Original 170-second case deadlines and the native 180-request ceiling remain. Whole strict TypeScript and voice-test emission pass in work 1792648371160; all 722 serving bytes are exact. The earlier pre-compiler admission refusal is scheduling evidence, not a compiler failure.

Current class-source refresh work 1792648400830 passes 124 cases, including the ten canary controls. This replaces the old 123-source count for the current candidate because the canary unit-test root changed. Existing class SQL 27, financial source 113/SQL 21 and restore five are separately retained under checked unchanged source dependency closures and all 722 serving bytes, without rerunning or adding them to the new SQL13 total. No production, crypto issuer, scanner, privacy boundary, clinical permission, native request budget or operation deadline changes.

Current exact-head review, same-PR publication and fresh own-head cloud checks, ordinary corrected merge and independent actual-main verification remain delivery gates. Old failed runs stay failed. No live clinic/provider acceptance, staff-review publication, activation or complete-roadmap claim follows from these synthetic tests.

Static review also identified that the original unrelated phone sentinel could contain an admitted six-digit code. The refined sentinel has no six-digit substring ending in zero; a pre-issuance assertion enforces that relationship with the unchanged SQL canary space. The source124, whole strict/emission722 and normal concurrent13 checks above were refreshed after this correction. Three stale current123 prose references are now explicitly historical.
