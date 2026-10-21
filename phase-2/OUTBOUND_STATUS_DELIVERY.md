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

This is local engineering qualification. Normal PR #575 parent integration,
fresh exact-head cloud checks and normal review remain required before this
change is published/merged. Default hosting configuration is unchanged. Complete
no-stop/private/all-ASR coverage, actual clinic/provider/source/restore and
acoustic acceptance, gap 13 implementation and the full execution-order goal
remain open. No deployment or live-call authorization is inferred.
