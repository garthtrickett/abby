# Approved communication-memo engineering

The owner selected separate confidential Cliniko communication memos for
verified administrative booking, rescheduling and cancellation facts. Existing
appointment and treatment notes remain untouched. This branch implements the
native-record primitive, optional individual-booking receipt capture and optional
observed cancellation/rescheduling capture through the approved session/voice
compositions. Patient-specific ordinary/pass class booking and class cancellation are also
locally qualified. Partial/completed class movement reports are also locally
qualified below; complete recovery remains unfinished. No default configuration,
live write, signed voice acceptance or completed gap 13 is claimed.

## Native contract

The adapter creates a memo through `POST /communications`, using category 12,
confidential storage and phone-call type 3. Direction 1 means sent and 2 means
received; it must come from the actual authorized conversation. It omits
sender/recipient guesses and unsupported author fields. Numeric codes are
matched independently of illustrative response labels. Creating this record
does not send a communication. The API user and separate clinic author policy
still need approval. [Official communication reference](https://docs.api.cliniko.com/openapi/communication).

Archived reads explicitly request `archived_at:*`, which includes archived
records rather than silently treating their absence from a default view as
absence of the effect. [Official filtering contract](https://docs.api.cliniko.com/#filtering-results).

## Integrity and one-use ownership

The strict codec accepts allowlisted administrative facts, exact individual
appointment references and canonical intervals. It accepts no transcript,
treatment text or arbitrary prose. A separate MAC protects the canonical
original action, subject, account, author, policy, direction and outcome; it
does not prove patient verification, clinical success or permission.

One fixed purpose is derived from the original clinical action UUID. Changing
the key, policy, author or operation label cannot create a second purpose. The
adapter requires independent current native and producer grants, shares the
physical API-user budget, and claims the existing real opaque SQL exclusion
before its only possible POST. It uses a whole deadline and bounded owned body
reader. A known exact acknowledgement remains known when later disclosure is
withheld; headers alone or a lost/nonexact body remain uncertain. A spent
unretained purpose cannot POST again.

The read-only interface needs separate preliminary and decoded-record grants.
It can read a known communication reference; cold discovery without that
reference is not implemented yet. The adapter does not edit or archive records,
add a local private queue, or retry the original clinical action.

## Earlier native-primitive checkpoint, 21 October 2026

The corrected source cohort passes 46/46 (1792549862370), and its affected strict
graph passes (1792549864095). The earlier type attempt failed only because this
new code used a parameter property forbidden by the repository's erasable-only
TypeScript setting; that syntax is corrected and the failed evidence retained.

Full strict TypeScript and the actual serving build pass (1792550201020,
5m44s, peak 1,664,761,856 B/2 GiB). There are 685 outputs: two new memo modules
and every original 683 output byte unchanged. A single nonemitted SQL driver
was added afterward; its affected strict graph passes (1792550617521), with
all serving inputs and output hashes preserved.

Five actual emitted/PostgreSQL cases pass (1792550728861): exact acknowledgement,
stored and unretained response loss, parallel callers, and policy/key change
after uncertainty. They use the real native-180 SQL budget and permanent effect
barrier, retain unrelated legitimate SQL state, scan every column and inspect
the complete unfiltered backup. Remote native transport, clinical source facts
and grants are synthetic; these cases do not prove an actual clinical receipt
or host integration. Own databases are isolated and cleaned, CPU/RAM bounded,
swap disabled and OOM/high/max counters zero.

## Individual booking checkpoint, 21 October 2026

The actual native writer registers an immutable acknowledgement in its private
WeakMap before its existing observer. A cloned receipt, public completed flag,
later diary match or different writer cannot supply this provenance. The actual
booking guard separately retains the verified dispatch subject, account,
clinical digest, interval and original admission direction. Existing inbound
admissions omit a direction field; their established inbound shape is mapped to
received memos. Only both owning objects together can produce the memo facts.

`ClinikoBookingMemo` captures the original preparation before reviewed send,
then joins that private dispatch source to the actual writer acknowledgement.
It adds no native, permission or database read after final availability. The
optional configuration passes through returning-patient and registration-to-
booking compositions, including catalogue members and incoming/outgoing voice
owners. Clinic ports are captured before asynchronous workflow selection and
must match the actual account and physical budget. No environment flag, public
command or default mounting enables memos.

A held-permission test first failed against the awaited memo path
(1792555233934, one real assertion failure, no skips/cancellations). The corrected
host returns its known clinical result while the separately bounded memo lifetime
continues. Its existing independent service signal, whole deadline, native
budget, permanent purpose and private outcome observer remain in force. This
volatile bounded operation is not a durable private queue or retry journal.
Memo failure, revocation, quota, observer failure or clinical-owner disposal
cannot erase the booking, repeat it or delay confirmation until the memo deadline.

Current host/session controls pass 21/21 (1792555308209), including the same held
permission case, exact subject, response loss, denied producer/current grants,
physical quota exhaustion and disposal immediately after native acknowledgement.
The current affected strict graph passes (1792555308456). Earlier approved
booking/intake preservation controls passed within 45/45 (1792554062621); their
scope predates the final nonblocking change. Whole strict and the initial
687-output build passed (1792554809185); that pre-latency source snapshot is
preserved separately. The current actual serving rebuild passes (1792555449127,
1m45s): only the host and its memo-session fixture outputs differ, with all other
685 output bytes preserved. Final current whole-tree TypeScript passes
(1792555799100, 3m07s, peak 1,648,001,024 B/2 GiB, Swap0/OOM-high-max0).
That booking checkpoint was committed locally as ca8764f after its facts, source,
naming, artifact and cleanup guards. It remains unpublished. The latest combined
source and runtime qualification is recorded below.

Ten current emitted/PostgreSQL cases pass together (1792555571529, 55s): the
five preserved native-primitive cases and five actual approved booking-session
cases for accepted, stored/unretained response loss, nonexact memo reply and
producer revocation after clinical send. The latter reconstruct actual file
approvals, registered-channel synthetic OTP, played menu/SAM, exact native
booking and the independently permitted memo using the emitted runtime. One
real SQL API-user bucket accounts for every clinical/verification request and
the memo; real verification budgets and permanent purpose exclusions are used.
Every-column scans and complete unfiltered dumps retain legitimate unrelated
phone aliases, staged scans and opaque effects. The tested flow's acted-on patient
ID, memo content, private proof, transcript, key and communication payload remain
outside local persistence. Owned
databases are cleaned; Node peak 172,376,064 B/1 GiB and external PostgreSQL peak
169,263,104 B/512 MiB, CPU100% each, Swap0/OOM-high-max0. Provider, mail and clinic
grants are synthetic. These are session/host checks, not a signed acoustic or
real clinic acceptance result.

The Karen reference was rechecked at its maintained sibling location. Its
Cliniko endpoint/category/type corroborate the native primitive. Its transcript,
phone-target and default confidentiality behavior does not supply Abby's chosen
administrative content or verified subject authority; the documented loss of an
acted-on patient is retained as an adversarial requirement.

## Observed cancellation and rescheduling, 21 October 2026

Cancellation and rescheduling keep their existing acknowledged-then-inspected,
best-effort clinical meaning. They do not become exact causal booking receipts.
The original writer privately owns the actual returned `cancelled` or `moved`
object, immutable request and inspected time. Clones, another writer, a later
matching diary read, uncertain sends and conflicted moves cannot supply that
source. The guard separately owns the verified dispatch subject/account/digest
and actual admission direction. No native IO or trusted-clock read was added to
the existing clinical dispatch checks.

The actual reviewed-send owner separately retains its original acknowledged
Cliniko recall marker and original request. That marker supplies one stable memo
purpose; a fresh post-action UUID, operation label, author or key cannot mint a
second purpose. `ClinikoAppointmentChangeMemo` joins these three owners only on
the existing host's final successful path. The strict codec explicitly records
`cancellationObserved` or `reschedulingObserved`, the
`acknowledgedAndObservedBestEffort` basis and original inspection time. A move
retains both practitioners and intervals, including an explicitly approved
practitioner-only move. Its wording reports observation after the request and
does not claim Abby proved sole causation.

The common retention module owns the same independent memo grants, service
lifetime, physical API-user budget, permanent purpose and native deadline for
booking and observed changes. An unavailable or delayed memo cannot delay,
replace or repeat a known clinical result. Existing clinical result shapes,
uncertainty/conflict handling and default activation are unchanged.

The actual approved-session cohort passes 22/22 (1792558990198), with no skips
or cancellations, and its affected strict graph passes (1792558990518). The
previous attempt passed 60/61 selected controls but rejected the new
practitioner-only fixture before session construction because its explicit
approved practitioner pair was missing. Its type attempt separately rejected a
redundant already-narrowed test comparison. Both fixture issues were corrected;
no production approval rule was relaxed.

Current whole strict TypeScript and the actual serving rebuild pass together
(1792559440505, 5m02s, peak 1,673,039,872 B/2 GiB). There are 690 outputs: three
new modules/fixtures, 13 expected changed outputs and all other 674 prior output
bytes preserved. This rebuild includes the actual changed sessions, common
retention module, native codec and emitted test fixture.

All 23 current emitted/PostgreSQL cases pass (1792559756856, 2m58s), with no
failures, skips or cancellations: 13 actual cancellation/rescheduling cases,
five preserved booking-session cases and five preserved native-primitive cases.
The new cases cover exact memo acceptance, stored/unretained response loss,
nonexact memo response, independent producer denial, clinical-response loss and
an approved practitioner-only move. They check the original native review
marker, explicit observation grade, one physical SQL-180 bucket and permanent
SQL purpose. Every-column scans and the complete unfiltered backup exclude the
tested subject, proof, review/memo content, source marker, private key and call
identifiers while retaining legitimate unrelated aliases, staged scans and
opaque effects. Node peak is 178,507,776 B/1 GiB; external PostgreSQL peak is
126,189,568 B/512 MiB, CPU100% each, Swap0 and OOM/high/max0. Owned containers
and databases are cleaned. Provider, mail, clinical transport and clinic grants
remain synthetic; these are not signed acoustic or real clinic acceptance.

## Patient-specific class booking checkpoint, 21 October 2026

The optional class producer records only the verified patient's exact created
attendee and occurrence, using `classBookingConfirmed` and the original native
attendance action UUID. Its wording says class booking, not physical attendance.
It does not write shared class notes or claim money, remaining case balance or
whole-move completion. The native writer privately owns the exact guarded
receipt: generic acknowledgements, clones, another writer and later inspections
cannot supply it. The existing host privately retains verified dispatch facts
before final capacity, with no added native IO. It captures the memo source
before the clinical acknowledgement observer can dispose the host; independently
bounded retention cannot delay or erase that clinical result.

The current admitted ordinary/pass source cohort passes94/94 (1792560878541),
with no skips/cancellations. Its affected strict graph passes (1792560889372).
Earlier106 controls passed before clarifying the outcome name; their type
attempt found a missing presence check in the synthetic grant helper, corrected
without changing production permission.

Whole strict and initial691 serving pass (1792561123072). The first actual SQL35
run (1792561463000) passed29 and failed six pass cases before attendee POST; all
previous23 memo cases and six ordinary class cases passed. The focused red trace
(1792561816336) measured58 prior requests plus147 required headroom under real180.
The helper had advanced its simulated clock, which cannot advance PostgreSQL's
clock. The correction really waits in at-most15-second steps while renewing the
synthetic connected-call lease. It does not age SQL rows, raise account quota,
weaken source grants or change production30s effects or proof/offer expiry. The
new class harness deadline120s accommodates an up-to60s pre-confirmation wait.

Corrected fixture/driver strict passes (1792562066556,1792563273578). The actual
corrected691 rebuild passes (queued work1792562910805, serving start06:09:38UTC,
peak1,149,108,224 B/2GiB): only the intended test fixture output changes; all
other690 output files remain byte-identical. Earlier capacity refusals occurred
before compilation and are retained separately. Fresh live admission and one
fair start governed the eventual build; no peer was interrupted. Final current
whole-project strict passes (1792563755361,3m04s,peak1,656,115,200 B/2GiB).

The exact previously red pass accepted case passes with a real quota wait
(1792563414514,1/1). All12 current emitted class SQL cases then pass separately
(1792563711381,7m56s), zero failures/skips/cancellations: ordinary/pass pairs of
accepted, stored/unretained response loss, nonexact memo response, denied memo
producer and lost clinical response. They reconstruct the actual admitted class
owner, its own email proof, approved class/pass and explicit no-deposit financial
policy, played SAM and exact native attendee response. They prove neither paid
membership nor receipt/charge processing.

The real SQL180 account bucket includes verification, protected class/pass work,
native writes and the independent memo. A final-state witness uses actual prior
and final rolling-minute timestamps, proving one memo increment while allowing
legitimate expiry across windows; cumulative calls are not confused with one
minute's capacity. Real SQL verification budgets and permanent memo purposes
remain in force. Every-column scans and complete unfiltered backups exclude the
tested patient/proof/call/memo/key/source marker and private class/pass content,
while retaining unrelated legitimate aliases, staged scans and opaque effects.
Node peak147,034,112 B/512MiB and external PostgreSQL peak139,579,392 B/512MiB,
CPU100% each, Swap0/OOM-high-max0; owned containers/databases are cleaned.

The previous23 actual memo SQL passes retain their scope: their test sources and
all other690 runtime output bytes are unchanged, and the changed class fixture
is not loaded by those drivers. This is scoped preservation, not another fresh
35-case run. The original failed35-case evidence is retained with its exact2034
source inputs and691 runtime artifacts in a hash-verified private archive.
Provider, mail, Cliniko transport and clinic grants are synthetic. Actual signed
voice, native clinic acceptance and a full completed gap13 are not established.
The component remains local/unpublished with default activation inactive.

## Patient-specific class cancellation checkpoint, 21 October 2026

The admitted ordinary and approved-pass cancellation owner now captures optional
`classCancellationObserved` facts. The original writer privately owns its exact
accepted attendee PATCH object; the reviewed-send owner supplies the original
acknowledged review marker. Private successful dispatch and inspection frames
bind the verified patient, exact attendee/occurrence, interval, account,
policy/terms and direction. Clones, another writer, generic review success,
uncertain native replies and foreign inspection results cannot supply this source.
The codec explicitly records `acknowledgedAndObservedBestEffort` and the existing
inspection time. It reports the cancelled patient attendee as observed, without
claiming sole causation, refund, released credit or remaining pass balance.

Native IO, clinical headroom/permission checks, pass inspection, the30s effect
and existing success/uncertainty semantics are unchanged. Source capture uses
the existing dispatch/inspection clocks; independently bounded retention cannot
delay or replace the clinical result. Optional configuration remains inactive
unless supplied through the approved composition. No shared-class notes or
private durable queue are introduced.

The current source cohort passes158/158 (1792565709400), including all16 new
memo cases, existing ordinary/pass cancellation host controls, nominal source,
codec/review and individual/class-booking memo regressions. Affected strict
TypeScript passes (1792565724219). Whole strict and the actual692-output serving
build pass (1792566054671,4m45s,peak1,631,252,480 B/2GiB). There is one new emitted
cancellation fixture and seven expected changed runtime outputs, including the
shared native writer/codec. Earlier memo SQL cohorts are historical evidence;
their complete runtime scope is not byte-preserved by this change.

All15 current emitted cancellation PostgreSQL cases pass (1792566545320,
11m41s,zero failures/skips/cancellations). Six ordinary cases cover accepted,
stored/unretained memo response loss, nonexact reply, producer revocation and
lost clinical response. Each approved-pass profile (`releaseOne`, `unchanged`,
`consumeOne`) separately passes acceptance, stored memo response loss and lost
clinical response. A first real releaseOne acceptance also passes
(1792566440002). A fresh actual approved-pass class-booking SQL regression passes
against the changed shared writer/codec (1792566558922).

Each case reconstructs the actual admitted class owner, private verification,
played terms/SAM, existing clinical PATCH/inspection and original review-bound
memo purpose. The same real SQL180 bucket accounts for verification, protected
clinical work and memo requests. Pre-confirmation quota waits use actual elapsed
time with lease renewal; they do not rewrite quota rows, raise the limit or
extend the production30s effect. Numeric memo-only observations distinguish
post-PATCH clinical inspection from memo requests and honor rolling-window expiry.
Real SQL verification budgets and permanent purpose exclusions remain active.
Every-column scans and complete unfiltered backups exclude the tested subject,
proof/call/review/memo/key and private class/pass values while retaining legitimate
unrelated aliases, staged scans and opaque effects. Owned databases/containers
are cleaned. Node peak151,027,712 B/512MiB and external PostgreSQL peak123,256,832
B/512MiB, CPU100% each, Swap0 and OOM/high/max0. Clinical/provider/mail transports
and grants are synthetic. Signed acoustic, full combined runtime and real clinic
acceptance remain separate; this component is local and unpublished.

## Partial and completed class movement reports, 21 October 2026

The actual native movement owner now privately associates each returned result
with the original request actually passed to execution. A result clone, public
progress object, other mover or edited returned object cannot supply that source.
Request capture precedes asynchronous execution, so later mutation of the caller's
input cannot replace its original UUID, subject or targets. Reports have their
own time and explicit `nativeWorkflowReportBestEffort` basis: the report time
is not represented as the time of each earlier native inspection or as an exact
causal acknowledgement.

The optional producer joins this owned source to the actual host's verified
played dispatch, exact patient/targets/account and captured incoming/outgoing
direction. It emits `classMovementReported` with separate original attendee,
replacement attendee when known, occurrence intervals, original/replacement
mutation observations and membership-association observation. Fixed wording
identifies prior observations, uncertainty and overall workflow status. It
includes no pass balance, payment, credit, refund or shared-class note. The
codec refuses a `moved` report unless original cancellation, active replacement
and any required association have the existing inspected states; restoration
has its own distinct state combination.

Paused stages do not spend the one root purpose. Completion or disposal retains
only the latest owned report, derived from the actual original native action
UUID rather than a fresh post-action UUID or public continuation. Disposal during
an active phase waits for its bounded native result before retaining uncertainty.
A partial, interrupted or uncertain route stays `needsReview`; reporting cannot
continue a clinical stage, repeat a write or promote partial success. The same
independent memo permissions, service lifetime, physical budget and permanent
purpose apply. Clinical stage admission, private renewed proof, distinct played
consent, compensation policy and30s effects are unchanged. Actual host/session
composition remains optional and inactive by default.

Current source115/115 passes (1792569322980), including native source ownership,
input/result mutation, admitted ordinary/pass stages, partial disposal, native
and memo response loss, independent denial, non-staged completion/compensation,
disposal during a PATCH and held memo permission. Earlier109 and115 runs passed
before the final synthetic counter correction. The affected graph passes
(1792568705445). Current whole strict and actual694 serving pass
(1792569347778,4m22s,peak1,645,678,592 B/2GiB). Relative to the initial movement
build, only its test fixture output changes; the other693 bytes remain identical.
The initial movement build had five expected changed outputs and two additions
relative to the prior692-output cancellation checkpoint.

The first real partial SQL attempt (1792569087885) passed its clinical, memo and
purpose assertions but failed its diagnostic comparison: spreading the fixture
materialized the initial `claims` value instead of forwarding its live getter.
No all-column/raw-backup pass was claimed for that failed run. Its exact2043
source inputs and694 outputs are preserved in a hash-verified private archive.
The correction forwards the real getter; it changes no production source,
quota, time, assertions or privacy filters. The exact previously red case then
passes through the full privacy checks (1792569640216,1/1).

All10 current emitted PostgreSQL cases pass (1792569860967,25m31s), zero
failures/skips/cancellations: ordinary/pass pairs of completed move, partial
disposal, lost original reply, stored memo-response loss and producer withdrawal.
Each uses the actual admitted class session, file approvals, private OTP, played
SAM, native reviewed movement and independently retained memo. Real elapsed
quota waits renew the synthetic live lease; neither SQL timestamps nor the
native180 account limit are altered. The600s test harness accommodates several
pre-confirmation windows and renewed proofs; production30s phase effects remain
unchanged. One actual SQL bucket covers the full workflow and memo, and one
permanent root purpose prevents another memo POST. Every-column scans and full
unfiltered backups exclude tested subjects, proof/call/review/memo/key and class/
pass values while retaining legitimate unrelated aliases, staged scans and opaque
effects. Node peak141,721,600 B/512MiB and external PostgreSQL peak122,937,344
B/512MiB, CPU100% each, Swap0 and OOM/high/max0; owned databases/containers clean.
A fresh shared-codec ordinary cancellation SQL/privacy case also passes
(1792569656098,1/1). Older memo SQL cohorts retain their historical scope rather
than becoming a fresh combined694 pass. Provider, mail and clinic grants remain
synthetic; signed acoustic and actual clinic acceptance are not established.

## Work still required

The current individual/class source producers and partial movement reports have
local scoped qualification. Qualify distinct verified subjects, representative,
financial, catalogue and actual signed incoming/outgoing voice combinations.
Keep known clinical acknowledgement irrevocable after memo quota, permission,
source, observer or response failures.
Exact clinic templates, local presentation, author, confidentiality/viewer roles,
retention and per-operation permissions remain separate requirements.

Add independently permitted complete native history, protected original-bound
recovery without lost local references, process-loss and full logical-restore
proofs. Retain all-column/raw-backup privacy and real physical-budget admission.
Then qualify the actual combined host/serving paths, keep operator facts and
scenarios current, and complete normal parent integration, exact-head cloud
checks and review before publication. The memo branch is based on normally
merged PR576/main1c; later normally merged outbound PR575/577 are tracked
independently and still need integration into this candidate. Attachments and
other storage types stay separate.

Outbound complete no-stop/private/all-ASR reporting and real acoustic/provider/
clinic acceptance remain open. Independent memo engineering does not close or
bypass those execution-stage requirements or the full thirteen-gap goal.
