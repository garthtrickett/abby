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

The destination is currently fixed by trusted host setup. General caller choice
among a current approved practitioner directory, retained source-practitioner
preference, a spoken switch when no suitable time exists, and new dialogue/model
qualification remain implementation work. No clinic/provider/carrier activation
or acoustic acceptance follows from these synthetic journeys. Gap6 recurrence
and historical additive-volume evidence, gaps8–13 and authoritative CI/real
clinic/mail gates remain open. The full thirteen-gap objective remains active.


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
