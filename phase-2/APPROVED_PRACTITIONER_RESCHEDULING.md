# Approved practitioner rescheduling: gap7 progress

## Contract

A rescheduling approval may contain an explicit bounded list of practitioner
moves. Each entry names the source practitioner, destination practitioner,
appointment type and unchanged duration:

```json
"practitionerMoves": [
  {
    "fromPractitionerId": "22",
    "toPractitionerId": "23",
    "appointmentTypeId": "33",
    "durationMinutes": 30
  }
]
```

The decoder accepts1–72 unique entries with exact keys, distinct native
practitioner IDs and durations1–480 minutes. The approval remains scoped to
business, credential, policy version, clinic/location, current administrator
membership and declared fee/notification ownership. Each edge authorizes only its recorded direction, type and duration; unknown
keys cannot authorize movement. Legacy approval
continues to require the same practitioner.

A trusted host may configure `reschedulingDestination` with a practitioner and
booking approval path. The clinical host, call flow and rescheduling session
freeze that setup. An independent current booking approval validates the new
member's native activity, relationships, service/duration, zone, labels and
available time. Before verification, the session checks that the declared
source/destination edge matches its native source setup. The concrete authority
rechecks the actual protected source appointment, pair approval and destination
policy at proposal and final send. Caller/model input supplies dates and played
ordinals; it cannot supply the native destination or approve an edge.

## Appointment and confirmation

Patient, appointment identity, business/location, type and duration are retained.
The public action includes a host-derived practitioner-change fact, so a
same-time change can be distinguished from an unchanged appointment. The
confirmation names the destination explicitly. It describes the existing
appointment by its date/time rather than attributing the original visit to the
new practitioner. The digest binds that fact and the approved public offering.
A current private menu preserves the original time only when the configured
destination differs from the protected source practitioner.

[Cliniko's update endpoint](https://docs.api.cliniko.com/openapi/individual-appointment/updateindividualappointment-patch)
accepts `practitioner_id`. The adapter sends one in-place PATCH to the original
appointment with `starts_at`, `ends_at: null` and the changed practitioner.
Practitioner-changing writes require trusted final-send and inspection hooks;
legacy writes retain their existing behavior. Exact new member/time/type/patient/
business/duration readback plus conflict inspection is required for success.
A response alone cannot establish completion; an unknown response retains one
attempt. The existing provider review protocol now records the old and new
practitioners and accepts legacy records. Review remains context for staff.

## Qualification

E2E-359 covers changed/same-time native moves, named played confirmation,
protected source/destination selection, pair/destination/permission withdrawal,
metadata drift, one-attempt uncertainty, malformed approvals and callback/ID
validation. Three actual compiled signed caller journeys use private TLS code
verification and native body/readback checks; private canaries are scanned.
Typecheck/build and30 compiled/source/default-runner checks passed without skips
in `4590eee3-1791902530221.log`;58 focused source/legacy/session/review checks
passed in `4590eee3-1791902126116.log`.

The report retains earlier failures. Typecheck caught a test reading speech text
without narrowing a transfer-capable presentation. The first compiled run then
exposed a real menu filter that removed the original time during a practitioner
change. The filter was fixed. The uncertain-outcome test also waited for another
spoken response after terminal escalation; it now observes the closed transport
and retains the one-PATCH assertion. No runtime limit, worker count, permission
or write-replay safeguard was relaxed.

Final qualification passed typecheck, compiled build, diff check and101 tests
without failures/skips in `4590eee3-1791902828518.log`. Manifest1.166 registers359 stable scenario IDs;
full carrier evidence remains planned.

## Remaining gap7 work

The caller directory, original-practitioner preference and spoken switch are
now implemented and locally qualified below. Actual model and acoustic
acceptance, real clinic/provider configuration and current authoritative CI
remain unestablished. Gap6 recurrence and historical additive-volume evidence,
gaps8–13 and real clinic/mail/carrier gates remain open. The full thirteen-gap
objective remains active.


Final command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh node --test --test-concurrency=4 test/voice/compiled-practitioner-move.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/integrated-clinical-runner.test.ts test/cliniko/practitioner-rescheduling.test.ts test/cliniko/reschedule-write.test.ts test/cliniko/rescheduling-authority.test.ts test/cliniko/rescheduling-clinic-policy.test.ts test/cliniko/rescheduling-session.test.ts test/cliniko/reviewed-send.test.ts test/cliniko/cancellation-review-context.test.ts test/cliniko/review-discovery.test.ts test/text/agent-appointment-proposals.test.ts test/text/rescheduling-setting.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts && git diff --check
```

Tracked job: `Abby practitioner change final source core compiled and registry gate`,
exit0. These are local results; authoritative cloud CI must execute before merge.

## First executing cloud qualification

Head6b41282 received an actual successful PR workflow: run38417234095 completed
success across typecheck, text-contract, browser-contract and postgres-proof.
The push workflow38417224138 failed its first text guard, E2E-321 in
`test/text/booking-horizon.test.ts`, while its disposable PostgreSQL fixture was
pulling the uncached postgres:17-alpine image inside the existing10-second
Docker startup limit. The completed job log records unfinished layer pulls and
SIGTERM/exit143; no horizon assertion executed in that failing backend setup.

The exact guard passes locally with the image available (log
`4590eee3-1791903978592.log`). The text job now prepares that already-required
image before the suite; the Docker fixture limit and test deadline remain
unchanged. The prerequisite command plus the exact guard and diff check passed
(log`4590eee3-1791904090785.log`). This is a CI prerequisite correction; it adds
no dependency and changes no repository variable, secret or permission. The
corrected published head still requires fresh authoritative qualification.

Commands:

```sh
docker image inspect postgres:17-alpine --format '{{.Id}}'
node --test --test-concurrency=4 test/text/booking-horizon.test.ts
docker pull postgres:17-alpine && node --test --test-concurrency=4 test/text/booking-horizon.test.ts && git diff --check
```

## Cancellation deadline correction

Both workflows on `656daba` finished with failures. PR run38419696139 failed
text-contract, and push run38419690065 failed postgres-proof, at E2E-299's
expired cancellation-evidence observer. The observer could declare a stall at
the 15-second boundary before an already-due runtime timer was delivered. Code
inspection also found that the cancellation host ignored the external evidence
abort signal, leaving the provider read governed by a later host deadline.

The host now combines caller, lifetime and unchanged 15-second deadline signals
before resolving evidence and rejects a result if that combined signal has
aborted. The test observer rounds the remaining budget upward and observes one
event-loop delivery of already-due timers before declaring a stall. It does not
renew a runtime deadline. The signed expiry test now requires the provider
signal to be aborted when the caller operation settles, before releasing the
held response, and retains its no-action/no-write assertions.

A direct protected-read regression also checks that a pre-aborted caller
starts no provider read, and an abort during a held read settles without a
proposal or clinical/review write. Its fixture signals when the provider read
is held. The first version instead polled 100 immediate turns and failed before
the approval-file reads completed; that failed result is retained in
`4590eee3-1791905784634.log` (50 passed, 1 failed, zero skips). The explicit-held
fixture regression passed 8 checks in `4590eee3-1791905995212.log`. Earlier
typecheck and 36 affected checks passed in `4590eee3-1791905525287.log`.
An earlier 16-check observer command included nonexistent
`test/voice/rescheduling-menu.test.ts`; it provides no evidence for that file.
The final command below names existing files explicitly.

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh node --test --test-concurrency=4 test/cliniko/cancellation-authority.test.ts test/cliniko/standalone-cancellation.test.ts test/voice/appointment-evidence-observer.test.ts test/voice/cliniko-workflow-call.test.ts test/voice/clinical-model-workflow-call.test.ts test/voice/standalone-clinical-runner.test.ts test/contract/scenario-manifest.test.ts && git diff --check
```

Final exact-source qualification passed typecheck, compiled build, all 51
checks and diff check, without failures or skips, in tracked job
`Abby cancellation deadline final exact source qualification`, exit 0, log
`4590eee3-1791906029224.log`. Fresh cloud qualification is required after
publication. Caller choice among approved practitioners and the other remaining
gap work above are still open.

## Caller practitioner directory

Trusted clinical hosts can provision `reschedulingPractitioners`, a list of
independent practitioner/booking-approval paths in addition to the primary
booking approval. A session freezes that list before reading approvals and
retains one verifier, protected appointment selection and send attempt. This
configuration cannot be combined with the earlier fixed `reschedulingDestination`.
Up to 24 total practitioners are supported; duplicate members, foreign scope,
credential, business, service, zone or policy bindings are rejected.

An appointment's original practitioner remains preferred until an explicit
played directory choice. The directory checks current directional pair approval,
unchanged duration/type and native activity/relationships/labels. It presents
three public names at a time. `nextPractitioners` reads the next page only after
the previous page was played; native identifiers stay in the private owner.
Only names or ordinals from that current played page resolve a choice. An
unheard name or model ordinal cannot select a member. New selection rechecks
the original appointment, patient permission, approvals and displayed name.

Changing the practitioner destroys all previous time references and creates a
fresh destination offer owner. The caller then chooses a new time and hears
named confirmation before one in-place PATCH. An empty original search can ask
whether to check alternatives; answering yes opens the directory and cannot
affirm an appointment change. Listing alternatives alone leaves the original
preference and appointment intact. Strict per-call scope/session/played-page
checks and current final-send authority remain in place.

E2E-360 registers text, signed and compiled evidence at manifest 1.167 / 360 IDs.
The signed journeys use the actual clinical resolver at prompt v26 and inspect
changed/same-time practitioner PATCH bodies. Two compiled ordinary-caller
journeys use PostgreSQL and TLS verification, inspecting a confirmed native move
and an uncertain one-attempt response. Neither real acoustic quality nor actual
recipient/provider/carrier acceptance is inferred from those fixtures.

The following failed runs are retained: the first type gate exposed name/time
snapshot narrowing; the first 54-test run rejected the new stage at the old
command schema (45 passed, 9 failed). The next 9-test run reached the final
writer, but the synthetic provider still asserted only a preset destination
(8 passed, 1 failed). Its fixture now strictly validates the configured member
cohort, exact body keys and applied member readback. The first signed run also
used the business ID in a per-member availability fixture key and observed an
unused original-provider counter; corrected tests inspect the signed fixture's
exact native PATCH body. Finally, the first compiled run returned before
installing its verification-result observer. Moving that observer ahead of the
new branch preserves the original wait and real verification path.

Corrected runs passed 27 source checks (`4590eee3-1791907647357.log`), 13 signed/
directory checks (`4590eee3-1791907949662.log`) and 16 compiled/directory checks
(`4590eee3-1791908358915.log`). Final exact-source qualification passed
typecheck, compiled build, all 99 checks and diff check with no skips/failures:
tracked work `Abby caller practitioner choice final source compiled model and registry gate`,
log `4590eee3-1791908652163.log`, exit 0. No worker count, runtime deadline,
permission, privacy or mutation-inspection gate was relaxed.

Final command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh node --test --test-concurrency=4 test/cliniko/practitioner-directory-rescheduling.test.ts test/voice/practitioner-directory-call.test.ts test/voice/compiled-practitioner-directory.test.ts test/voice/compiled-practitioner-move.test.ts test/cliniko/practitioner-rescheduling.test.ts test/cliniko/rescheduling-authority.test.ts test/cliniko/rescheduling-session.test.ts test/cliniko/rescheduling-clinic-policy.test.ts test/cliniko/reschedule-write.test.ts test/voice/clinical-model-workflow-call.test.ts test/voice/openai-clinical-intent.test.ts test/voice/standalone-clinical-runner.test.ts test/text/rescheduling-setting.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts && git diff --check
```

The preceding a56dec8 workflows did not start because of GitHub billing/payment
or spending-limit annotations. This source revision requires fresh exact-head
CI after publication. The PR remains draft while authoritative qualification
is unavailable, and the original thirteen-gap objective remains active.
