# Cliniko service variants

This optional addition advances gap 5 of the thirteen-gap integration plan.
An admitted location can approve up to twelve exact service variants, each with
its own provider appointment type, duration, initial/follow-up classification
and up to three approved practitioners. It preserves the existing single-type
configuration. No production service or patient workflow is activated here.

## Approved source and host configuration

`OwnerFileServiceCatalogue` captures an owner-only current clinic approval and
admin membership. Its exact source extends the existing eight clinic approval
fields with `policyVersion`, `businessId`, `credentialFingerprint`, `timeZone`,
`locationName`, `eligibilityBasis: "callerAttestation"` and `services`.

Each service has exactly these fields:

```json
{
  "serviceRef": "physiotherapy-follow-up",
  "name": "Physiotherapy",
  "appointmentTypeName": "Physiotherapy follow-up",
  "appointmentTypeId": "33",
  "durationMinutes": 30,
  "visitKind": "followUp",
  "searchDays": 7,
  "followUpRule": {
    "returningRequired": true,
    "newProblemRequiresInitial": true,
    "maxMonthsSinceLastVisit": 3
  },
  "practitioners": [{"practitionerId": "22", "name": "Demo Practitioner"}]
}
```

These are synthetic values. Initial variants have `followUpRule: null`.
References and type IDs must be unique; public name/visit-kind/duration tuples
cannot be ambiguous. Durations are whole minutes from 1 to 480. Search days
remain within the existing seven-day reader contract. Empty, duplicated,
malformed or unavailable sources cannot create a verifier or offer.

The trusted `ClinikoCallFlowConfig.serviceCatalogue` contains the approval path
and a private `services` array. Each entry maps its `serviceRef` to an ordered
`practitioners` array containing `practitionerId` and `bookingApprovalPath`.
Every member needs an independent existing booking approval for that exact
type, duration, service reference, business, credential, zone and practitioner.
Caller or model data cannot supply those IDs or paths.

The existing clinical host/runner draft #453 can supply this inherited flow
configuration after reconciliation. This patch's actual signed HTTP/WebSocket
journeys exercise the standalone transient call composition directly. It does
not install a participating clinic, public route or setup UI for the catalogue.

## Caller choice and eligibility

The portable workflow request carries only public `BookingServiceChoice`
attributes: name, visit kind, duration and optional explicit return answers.
Provider bindings stay in the call owner. A multi-service configuration requires
an explicit choice; a vague request or missing rule answer cannot select the
legacy default appointment type.

The current deterministic spoken selector accepts complete explicit requests,
for example “Book a sixty-minute initial Physiotherapy appointment.” or
“Book a 45-minute initial Massage appointment.” For a constrained follow-up,
the complete supported self-report form includes returning-patient status,
whether this is a new problem, and months since the last visit. These answers
are checked against the clinic-approved rules. Unknown answers, a new problem
requiring an initial visit, or an interval beyond the approved maximum deny
the follow-up; they do not silently book an initial variant instead.

This is an approved caller-attestation basis, not inferred provider history,
diagnosis, or proof of previous treatment. A clinic needing authoritative
history checks requires a separately implemented source and policy. The model
cannot manufacture a service selection or return answers. Unsupported explicit
service variants also clarify on a legacy configuration rather than falling
through to a guessed default.

## Exact booking and correction

Selection binds the corresponding provider reader, patient verifier, menu,
independent member policies and writer. The menu checks actual provider names,
duration, eligibility and online flags; current service approval remains a
parent authority for every offer resolution and final send. Withdrawal before
confirmation or after Cliniko review prevents the appointment POST. A source
change requires a new captured approval; matching an old file path is not
current authority.

An explicit unsent service change discards the previous owner, verification and
offered selections. The SAM cancels the previous unsent proposal. The new owner
requires fresh verification, fresh actual availability and a separately played
exact type/duration confirmation. A committed, unknown or otherwise possibly
sent action cannot be replaced by another service or retried. No action changes
an existing appointment in this patch.

The same selected public service and visit kind support a contextual duration
request such as “I want an hour appointment.” The cached caller request remains
transient and never enters the model context or durable storage. The new duration
must match another current approved variant; it receives new proof, availability
and confirmation. An unavailable duration cannot silently preserve the earlier
variant for later time requests or affirmations. In multi-service mode,
first-time registration still does not authorize its legacy default booking;
intake variant selection needs its separate implementation.

An explicit correction of return eligibility also disposes the selected owner
and proof and cancels the old unsent proposal. A later time request or “yes”
cannot reuse that stale follow-up. The caller must select again and reverify;
the system does not infer which replacement service is appropriate.

The selected service's independent policy also supplies the booking horizon.
The admission's original default type cannot supply bounds for a different
selected type. Location scope stays fixed; existing pre-admission routing is
separate from changing a service within a call.

## Qualification and remaining gap 5 work

`test/cliniko/service-catalogue.test.ts` covers exact selection, schema, explicit
rule answers, missing/negative/older answers, foreign scope, current authority,
required choice and prevention of default guessing.
`test/voice/service-catalogue-booking.test.ts` uses actual signed ingress,
transient SAM, registered-email proof, menus, current policy, Cliniko review,
independent synthetic provider metadata and real writer requests. It covers
60-minute initial, 45-minute massage and 30-minute follow-up bookings; replacing
an unsent service with fresh proof; stale parent approval before/after review;
provider duration/online drift; unknown writes; no retry; exact provider bodies;
and PostgreSQL patient-data canaries. Provider, mail, classifier and clear
transcription are synthetic.

The signed suite additionally covers a 45-minute initial variant corrected to
one hour without guessing a different service, an unsupported ninety-minute
request with no old-variant fallback, and corrected return answers followed by
new selection/proof. No post-send service change or unknown write can start
another appointment mutation.

This is engineering progress, not complete product parity. Gender preferences,
prior-practitioner lookup, multi-location service discovery, and
selection for first-time intake remain open in gap 5/8. Expanded horizons and
online-disabled services belong to gap 6; this patch still refuses them.
Actual speech quality, real clinic approvals/recipients and carrier evidence
remain separate. The original thirteen-gap objective is still active.

## Final local evidence

Whole-source typecheck, compiled voice/runtime build and all 46 affected/legacy
checks passed with zero failures or skips on the final executable/test source.
The signed new suite includes thirteen isolated scenarios behind its one test.
Tracked job `Abby service variants contextual duration final regression October 13`
completed exit 0; log
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791876204967.log`.

```sh
npm run typecheck
npm run build:voice-tests
node --test --test-concurrency=4 \
  test/cliniko/service-catalogue.test.ts \
  test/cliniko/booking-session.test.ts \
  test/cliniko/booking-offers.test.ts \
  test/cliniko/cliniko-call-flow.test.ts \
  test/cliniko/booking-horizon.test.ts \
  test/voice/service-catalogue-booking.test.ts \
  test/voice/preference-service-boundaries.test.ts \
  test/voice/approved-booking-search.test.ts \
  test/voice/booking-horizon.test.ts \
  test/voice/booking-search-windows.test.ts \
  test/voice/appointment-change-intent.test.ts \
  test/contract/scenario-manifest.test.ts \
  test/contract/no-number-gap-trace.test.ts
git diff --check
```

Earlier failures remain distinct: TypeScript inferred `never` after an empty
array deep assertion in the new fixture; asserting its length corrected that
test typing. Adding the approved 45-minute initial variant made its old negative
fixture stale; a positive exact-type check and a still-unavailable ninety-minute
case corrected the input contract. The unsupported-duration journey exposed an
invalid-transition route to a disabled menu after selection was discarded.
The public classifier context now returns to choose-service instead of reusing
the old menu. The final gate retains the original worker count, timeouts,
authority/privacy assertions and zero-skip requirement. These are local
synthetic results, not an executed GitHub CI or live acceptance claim.

## Guided selection (E2E-348)

The same optional catalogue now supports “I'd like to book an appointment”
followed by ordinary service, initial/follow-up and duration answers. Approved
durations are read aloud in ascending order, including when an unsupported
length is requested. The exact selected follow-up rule determines which caller
attestations are needed: attended before, new problem and months since last
visit. No patient lookup or verification email begins before these are complete.
These answers are self-reported facts, not verified appointment history.

`BookingServiceDialogue` owns partial answers and a question binding in volatile
call memory. Each next answer needs the latest question's exact turn ID, played
notice receipt, current call/session, bounded conversation revision and two-minute
question expiry. Settled text is erased by existing presentation retention; the
receipt is checked without restoring it. Every turn re-reads the current source;
a changed or revoked approval discards the partial choice. Unsupported or unclear
answers repeat the question, and explicit “Actually, an initial assessment” or
service-name corrections discard dependent old answers. Disallowed follow-ups
require fresh service selection. No clinical recommendation or automatic initial
booking is made. Existing single-send and private verification gates remain.

The new core notice has a strictly validated public field/options schema. Neither
model-generated service attributes nor private provider references can supply
these notices. Return answers are not added to the classifier or durable database.
Ten signed synthetic journeys cover actual positive native writes, ineligible
follow-ups, unsupported lengths, correction, changed/revoked source and interrupted
questions. These fixtures qualify dialogue and transport wiring; they do not
qualify acoustic speech accuracy or carrier/clinic acceptance.

### Guided-selection local qualification

Final unchanged-source gate: `npm run typecheck`, `npm run build:voice-tests`,
then `node --test --test-concurrency=4` over the new service-dialogue text/voice
files, existing service-catalogue, booking-session, booking-offers, call-flow,
booking-horizon text checks, service-catalogue booking, preference-service
boundaries, approved-booking-search, booking-horizon, booking-search-windows,
appointment-change-intent voice checks and scenario-manifest/no-number-gap-trace
contract checks, followed by `git diff --check`. All 48 checks passed, no skips.
Work label: `Abby guided service final affected regression October 13`.
Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791877650455.log`.

The first run exposed the settled-presentation text comparison described above.
A subsequent focused run exposed non-ascending duration options; sorting the
public minute choices fixed that. The final gate preserves timeouts, worker
counts, exact writer assertions, played-receipt fences and PostgreSQL canaries.
GitHub execution and participating-clinic acceptance remain separate gates.
