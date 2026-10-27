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

This is engineering progress, not complete product parity. Multi-location service discovery and selection for first-time intake
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

### History API capability

Cliniko documents patient/business/time and cancellation filters on its
[individual appointment list](https://docs.api.cliniko.com/openapi/individual-appointment/individualappointment),
and [custom ordering](https://docs.api.cliniko.com/#ordering). This supports
investigating a scoped prior-practitioner reader. It does not itself grant
patient permission, establish attendance or provide booking authority. E2E-351 implements an independent history owner with approved read-specific
permission, current subject/source checks, bounded-history/ambiguity outcomes
and separate practitioner choice/booking proof. No live history was read.

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

## Previous-practitioner lookup (E2E-351)

Optional `ClinikoCallFlowConfig.history` contains `callerApprovalPath`,
`historyApprovalPath` and an independent `appointments.read` permission. The
caller method approval must allow that operation. The new history approval
extends the eight common clinic approval fields with `policyVersion`,
`businessId`, `credentialFingerprint`, `timeZone`, `lookBackDays` (1–36525)
and `purpose: "previousPractitioner"`. Both current source and approving
membership are checked; default configuration supplies no history access.
Existing upcoming-only enquiry approvals and date bounds are preserved.

“Who did I see last time”, “Who was my last practitioner” and “Please book me
with the practitioner I saw last time” start a fresh history read verifier.
After private keypad verification, repeating the request reads the current
record. The owner has no writer. It reports the practitioner named by a past
appointment record in the approved period, a bounded empty result or ambiguity.
It does not infer attendance, clinical suitability or return-rule answers.
Unconfigured clinics retain their prior unsupported-history guidance.

The read uses fixed-origin requests and native patient/business/time filters
with descending start ordering. Every received record has matching patient and
business links, valid times inside the approved past window, canonical
practitioner link, unique ID, non-increasing order and valid cancellation/archive/
deletion/no-show flags. Excluded records cannot select a practitioner. Complete
latest-timestamp ties are read across pages before choosing one name; conflicting
practitioners remain ambiguous. A large ordered history may stop once the
latest eligible timestamp is complete. Five full tied pages or inconsistent/
partial pages cannot establish a default. Response links are validated as data
and never followed; budget, cancellation and bounded JSON limits remain.

Every protected read revalidates the subject and current approval before/after
provider use. Results, history facts and the subject binding stay in volatile
call memory, outside the classifier and durable database. Booking afterwards
uses the ordinary current service/practitioner questions, fresh independent book
verification, native guard/review and a separately played confirmation. The
lookup is restricted to the original verified patient until its source expiry;
a changed candidate cannot trigger another patient's contact read or code.
A read proof never becomes booking proof. Caller identity denial and call end
clear the binding. Earlier known/unknown patient sends retain their receipts and
cannot be replaced by a history lookup on the same call.

Fifteen signed synthetic journeys inspect positive history-to-booking, empty/
ambiguous/cancelled/no-show histories, foreign identities/businesses, ordering,
future records, provider failures, revocation during/before reading, permission
loss, changed subject and an existing booking proof requiring new read proof.
Separate tests cover denied approval, a cross-page tie and an 800-record ordered
history resolving without a full scan. Real clinic approvals, history coverage
and operating acceptance remain separate.

### Previous-practitioner local qualification

Final source: `npm run typecheck`, `npm run build:voice-tests`,
`node --test --test-concurrency=4` over previous-practitioner text/voice, native
appointments, appointment-enquiries, standalone-verified-appointment-read,
service-booking-entry text/voice, openai-clinical-intent, service-practitioner-
preference text/voice, service-dialogue text/voice, service-catalogue, booking-
session, booking-offers, call-flow, booking-horizon text, service-catalogue-booking,
preference-service-boundaries, approved-booking-search, booking-horizon voice,
booking-search-windows, appointment-change-intent and scenario-manifest/
no-number-gap-trace contract files, followed by `git diff --check`. All84 checks
passed, zero skips. Work label: `Abby previous practitioner final calendar-qualified
regression October 13`. Log:
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791884242194.log`.

The initial integration typecheck identified the new read-only owner in the
writer union; the writer explicitly excludes it. Focused signed qualification
and the prior83-check regression passed. Review then reproduced JavaScript
normalizing an impossible provider date (30 February), which could have named
a practitioner from an invalid record. Explicit calendar validation fixed that
without removing checks or broadening permission; the final84-check gate includes
the reproduction and retains all worker/deadline/privacy/native-write assertions.
These are synthetic local results, not CI execution or clinic/model/speech/carrier
acceptance.


## Shared-number location service discovery (E2E-352)

The transient serving composition can accept `locationServiceSources`, one
independently approved public service catalogue for each candidate location.
The directory checks current owner approval, membership, binding and location
name, then publishes only service name, visit kind and duration. The route
version includes approval and membership fingerprints. A changed or revoked
source prevents an older pending location choice from binding.

Before admission, callers can ask “Which locations offer Massage?”, “Where can
I book Physiotherapy?” or “What services are available at South?”. Replies
list approved variants and ask for an explicit location. Even a service listed
at just one location does not choose that location. No patient session,
verification, classifier invocation, provider read or writer starts during
this interval. The reply has its own transport playback receipt; subsequent
selection requires that receipt to be played and the current routing and lease
to match. Location selection then starts the existing scoped clinical workflow.

The signed synthetic journey uses two separate approval sets and distinct
Cliniko business IDs. It discovers public services, explicitly selects a
location, obtains fresh selected-location verification, plays the proposal and
confirmation, and inspects the exact native business/type mutation. Owner-file
tests separately cover changed revision, withdrawn approval/membership,
mismatched names and duplicate sources. This extends the trusted transient
composition; the existing single-location production CLI and the unmerged
clinical-runner branch still require reconciliation. Real clinic activation,
speech quality and carrier evidence remain separate gates.


### Location service local qualification

Final source passed `npm run typecheck`, `npm run build:voice-tests`, isolated
PostgreSQL migrations, the following affected regression command, and
`git diff --check`. All **135** checks passed, zero skips. Work label:
`Abby location services final source qualification October13`; log:
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791886711985.log`.

```sh
npm run db:migrate
ABBY_LEDGER=postgres node --test --test-concurrency=4 \
  test/voice/location-service-booking.test.ts \
  test/voice/prelocation-service-discovery.test.ts \
  test/cliniko/location-service-directory.test.ts \
  test/voice/prelocation-voice-session.test.ts \
  test/voice/shared-number-voice-call.test.ts \
  test/admission/pending-location.test.ts \
  test/voice/private-keypad-verification.test.ts \
  test/voice/twilio-connected-call.test.ts \
  test/voice/previous-practitioner.test.ts \
  test/cliniko/previous-practitioner.test.ts \
  test/cliniko/service-booking-entry.test.ts \
  test/voice/service-booking-entry.test.ts \
  test/voice/service-practitioner-preference.test.ts \
  test/voice/service-dialogue-booking.test.ts \
  test/voice/service-catalogue-booking.test.ts \
  test/voice/preference-service-boundaries.test.ts \
  test/voice/cliniko-workflow-call.test.ts \
  test/voice/embedded-intake-booking-call.test.ts \
  test/contract/scenario-manifest.test.ts \
  test/contract/no-number-gap-trace.test.ts
```

Earlier checks identified an interrupted service reply still permitting
admission and private input starting before shared-number admission. The core
binding guard and delayed private-input startup corrected those failures. The
accelerated signed fixture now advances its host clock with media timestamps.
The first broad run passed 123 checks and failed three: missing scenario IDs
in supporting test names, and two suites waiting for speech before observing
punctuated affirmative writes. Scenario names now carry the actual ID; write
waiting follows the awaiting action and real invocation, within the existing
30-second effect deadline. The targeted 11-check correction and final135-check
run passed without changing worker counts, deadlines or native/privacy
assertions. Earlier failure logs remain recorded:
`4590eee3-1791885878782.log`, `4590eee3-1791886091213.log`,
`4590eee3-1791886279237.log`. Manifest version1.159 tracks352 scenarios;
E2E-352 is synthetic evidence only. First-time intake variant selection and
combined runner reconciliation remain open within gap5; gaps6–13 remain in scope.


## New-patient service variants (E2E-353)

Explicit new-patient booking requests and validated registration routes can
start the same receipt-bound service questions with initial variants only.
The operation stays registration while the caller answers service, duration
and any/named/clinic-declared gender preference questions. No verifier, patient
record, offer or writer starts from incomplete or interrupted selection. An
explicit follow-up request cannot become a new-patient default.

The returning and intake owners share `approved-booking-composition.ts` for
current member approval, exact duration/type offers, complete eligible-group
reads, private menus, native writers and parent catalogue guards. Registration
still has separate recovery consent, private readback, prospective-email code,
clinic permission and played confirmation. Its service authority is rechecked
on every protected use, including immediately before patient creation. The
created-patient booking proof independently checks current contact and book
permission; it cannot borrow a returning-patient lookup or treat registration
as booking confirmation.

Before creation, an explicit supported duration correction replaces the
unsent owner, clears its private draft reference, and repeats consent, private
collection and code with a fresh private media collector. The old collector
stays closed at code entry. Unsupported variants remove old authority and
cannot save an earlier draft or use its menu. Known or uncertain patient and
appointment sends retain their outcome boundary and cannot start another
registration. A rejected/unavailable booking leaves the created patient intact.

Sixteen signed synthetic journeys cover direct, guided and model-routed intake,
service correction, declared gender, follow-up denial, interrupted choice,
pre-creation duration correction/denial, withdrawal before patient/appointment
send, provider duration drift, incomplete group read, denied independent book
permission and lost patient/appointment responses. Native patient/type/member
bodies, two played confirmations, private transcript separation and PostgreSQL
canaries are inspected. Combined compiled-runner reconciliation and actual
clinic/mail/speech/CI activation remain open; gaps6–13 remain in scope.


### New-patient service qualification

Current source passed `npm run typecheck`, `npm run build:voice-tests`,
`git diff --check` and **82** checks, zero skips:67 in
`Abby intake service final affected qualification October13`, plus15 in
`Abby intake classifier and prospective-permission regression October13`.
Logs:
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791888598392.log` and
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791888924884.log`.

The broad executed command used isolated PostgreSQL and
`node --test --test-concurrency=4` over the new voice journey; booking-session,
booking-offers, service-catalogue, intake-booking-session/PostgreSQL/process,
service-dialogue, service-booking-entry, clinical-workflow voice,
private-intake-spelling, service-catalogue-booking, service-dialogue-booking,
service-booking-entry voice, service-practitioner-preference voice,
location-service-booking, previous-practitioner voice and scenario-manifest/
no-number-gap-trace files. Two filename patterns in that invocation did not
resolve and supply no evidence. The actual classifier and prospective-intake
files were explicitly qualified afterwards:

```sh
bash scripts/with-postgres.sh node --test --test-concurrency=4 \
  test/voice/openai-clinical-intent.test.ts \
  test/cliniko/caller-mediated-intake.test.ts
```

Earlier checks exposed premature code submission in the new fixture, an
incorrect expectation that an unspecified preference chooses the earliest
member, and an unsupported ordinary answer. The corrected14-case journey
passed. Extending it with pre-creation duration correction exposed the stopped
private media collector. Recreating that collector with a new private session
suffix fixed the defect while preserving its closure at code entry and all
privacy/native assertions. The final16-case journey and existing spelling/
registration/process-loss suites passed. No workers, deadlines, permissions or
assertions were weakened. Earlier failure logs remain:
`4590eee3-1791887686038.log` and `4590eee3-1791888184505.log`.
Manifest version1.160 tracks353 scenarios; E2E-353 remains synthetic evidence.

## Original and alternative practitioner comparison

The locally qualified R02 candidate keeps one original public practitioner
while an explicit any-practitioner search checks the complete approved member
set. Comparison uses the same completed reads, current clinic-local search
bounds and exact service/location. It names the original time and duration,
explains an earlier or equal-time alternative, and distinguishes a complete
empty original from an unreadable original. Existing deterministic member
ordering remains unchanged. Both displayed intervals remain provisional.

The original is the current named preference or initial approved clinic member,
not an inferred last visit. “Check my original practitioner again” requests a
fresh normal menu for that member. Selecting its current time still requires
played menu/confirmation, fresh authority and the existing final send checks.
An interrupted menu or withdrawn member cannot authorize a write. A different
service/duration selection retains its existing explicit dialogue and approval;
the comparison value cannot silently substitute a service.

20 source checks, current strict types and a serving build with 745 outputs serving and three emitted signed SQL cases pass
locally; four prior signed search/deadline controls also passed. The initial
source omission and test setup/type failures retain their actual outcomes.
Independent review, normal delivery and clinic/acoustic acceptance remain
separate. See [current evidence](EXECUTION_PROGRESS.md#approved-practitioner-comparison-27-october-2026).

### Explicit service and duration corrections after comparison

The review-corrected candidate now has five actual emitted signed SQL passes.
After returning to the original practitioner, a caller can explicitly request
a separately approved 45-minute Physiotherapy type or Massage service. The old
proposal is canceled; fresh private verification, menu, played selection and
confirmation bind the exact final type and interval. Private keypad-gate audio
does not reach the public classifier. No different service is inferred from
comparison evidence. Current whole strict types and the unchanged prior 745
outputs plus one emitted existing fixture (746 total) are qualified. Original
failed attempts remain recorded; refreshed review, normal delivery and real
acceptance remain separate. See [the composed evidence](EXECUTION_PROGRESS.md#composed-r02-service-and-duration-correction-27-october-2026).
