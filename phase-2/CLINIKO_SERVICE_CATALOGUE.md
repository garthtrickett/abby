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

This is engineering progress, not complete product parity. Prior-practitioner
lookup, multi-location service discovery and selection for first-time intake
remain open in gap 5/8. Expanded horizons and
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

## Approved practitioner preferences (E2E-349)

Each service member still requires exactly `practitionerId` and `name`; the
clinic may additionally declare `gender` as `female`, `male` or `nonBinary`.
No gender is inferred from a name, voice or a provider response. Contradictory
declared names or genders for the same practitioner within the source invalidate
the catalogue. Absent metadata remains unknown for that service.

`BookingServiceChoice` may additionally carry a strictly validated public
`practitionerPreference`: `{kind: "any"}`, `{kind: "name", name: "Demo B"}` or
`{kind: "gender", gender: "female"}`. No IDs or private paths can be supplied.
Choices and nested preferences are copied/frozen before asynchronous approval
reads. Guided selection now asks the practitioner question after service and
return-rule answers and before patient lookup/verification. Unsupported names
repeat the question; unknown gender metadata cannot choose a default.

The private configuration maps the full approved service membership first, then
creates only the eligible member hosts. Each still uses an independent current
booking approval and native writer. The selected catalogue and every writer bind
the same preference to the current parent approval. A male writer cannot borrow
a female subset. Metadata changes or revocation invalidate that captured source
before offer selection, confirmation and the final write.

Gender and any preferences perform complete serialized reads over the eligible
set; partial evidence cannot establish earliest availability. Empty or failed
groups do not broaden to another practitioner. Named preferences select only the
exact approved canonical name. The ordinary menu/proposal/confirmation seams
retain native location, type and duration. Changing an unsent preference keeps
the service but cancels the proposal, discards old verification and requires a
fresh proof/confirmation. A prior known/unknown send remains final for this call.

An explicit contextual request such as “I prefer a female physiotherapist” uses
the same path after verification; ordinary dates such as “I prefer Mondays”
cannot become a service/practitioner replacement. No ranking, treatment-style
recommendation, inferred previous practitioner, existing-appointment practitioner
switch, real carrier proof or acoustic qualification is supplied here.

Sixteen signed synthetic journeys cover female/male/named/any positive writes,
unknown metadata/gender, unplayed question, missing member approval, current
metadata change/revocation, failed/empty groups, deterministic ties, preference
correction and lost-write recovery fences. Native provider metadata deliberately
contains no gender, making the approval source independent evidence. Durable
PostgreSQL canaries and classifier HTTP inspection remain in the qualification.

### Practitioner-preference local qualification

Final frozen-source gate: `npm run typecheck`, `npm run build:voice-tests`,
then `node --test --test-concurrency=4` over service-practitioner-preference
text/voice, service-dialogue text/voice, service-catalogue, booking-session,
booking-offers, call-flow and booking-horizon text checks; service-catalogue
booking, preference-service boundaries, approved-booking-search, booking-horizon,
booking-search-windows and appointment-change-intent voice checks; and the
scenario-manifest/no-number-gap-trace contract checks. `git diff --check` passed.
All 53 checks passed with zero skips, including sixteen signed preference
journeys and the earlier guided/service-variant cases. Work label:
`Abby approved preference final source qualification October 13`. Log:
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791879560289.log`.

The first signed run exposed a test's incorrect assumed confirmation word
order; the existing exact service/practitioner/duration notice was correct.
The broader gate caught an unknown-record-field type-narrowing error in the
contradictory-label check. It was fixed with the actual gender validator rather
than removing the check. Timeouts, workers, native writer assertions, current
approval fences and privacy canaries remain unchanged. These local synthetic
results do not establish GitHub execution, acoustic accuracy or clinic/carrier
acceptance.

## Generic booking entry (E2E-350)

A caller need not start with the exact short starter or a complete service
request. The existing clinical intent router may return a structurally validated
`workflow/book` route for the current ordinary request. With the optional service
catalogue configured, the owner starts the current approved service question
before any patient lookup or verification. The actual caller turn, session,
conversation revision, policy, source approval and cancellation signal are retained.
No invented caller wording or implicit service/visit/return answer is introduced.

The model response schema remains unchanged: no service choice, provider binding,
return facts or preference fields are accepted. Responses with extra choice data,
malformed fields, abort or an incompatible change intent cannot start this path.
When the catalogue is not configured, legacy routing is unchanged. Direct private
`choose("book")` without a complete public choice remains denied in multi-service
mode; the routing hook starts questions rather than authorizing booking.

Each answer still needs the previous question's actual played receipt and current
source. A generic restart of an unsent proposal discards the old owner and proof,
starts new questions and needs fresh verification/confirmation. Earlier known or
unknown writes keep their one-send fence. If initial service options cannot be
read, the new service-unavailable notice asks the caller to contact the clinic
without referring to a nonexistent previous choice.

Ten signed synthetic cases cover ordinary/make-booking/next-week wording, source
revocation during classification, source change after the question, interrupted
question, forged choice fields, provider 503, unsent restart to a different
service and lost-write outcome. These use actual signed ingress, volatile call
state, private keypad verification, exact native writers and PostgreSQL canaries.
The classifier's business-route accuracy and acoustic quality remain separate
qualification requirements.

### Remaining history work: verified API capability

Cliniko documents patient/business/time and cancellation filters on its
[individual appointment list](https://docs.api.cliniko.com/openapi/individual-appointment/individualappointment),
and [custom ordering](https://docs.api.cliniko.com/#ordering). This supports
investigating a scoped prior-practitioner reader. It does not itself grant
patient permission, establish attendance or provide booking authority. That
feature remains unimplemented; it needs approved read-specific permission,
current subject/source checks, honest bounded-history/ambiguity outcomes and a
separate approved practitioner choice/booking proof. No live history was read.

### Generic-entry local qualification

Final frozen-source gate: `npm run typecheck`, `npm run build:voice-tests`, and
`node --test --test-concurrency=4` over service-booking-entry text/voice,
openai-clinical-intent, service-practitioner-preference text/voice, service-dialogue
text/voice, service-catalogue, booking-session, booking-offers, call-flow and
booking-horizon text checks; service-catalogue booking, preference-service
boundaries, approved-booking-search, booking-horizon, booking-search-windows
and appointment-change-intent voice checks; and scenario-manifest/no-number-gap-trace
contract checks. `git diff --check` passed. All 61 checks passed, zero skips.
Work label: `Abby generic booking entry final regression October 13`. Log:
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791881098725.log`.

The focused gate also passed all twelve checks. Final qualification preserved
worker counts, deadlines, exact provider type, played-question/confirmation
receipts, fresh verification and PostgreSQL canaries. The slower final run
finished under shared machine load without a restart or relaxed gates. These
are local synthetic results; GitHub execution, real model/acoustic quality and
clinic/carrier acceptance remain separate.
