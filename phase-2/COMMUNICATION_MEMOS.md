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
It can read a known communication reference. The cold-history extension and
its separately granted original-review source are qualified below for the stated
ordinary-class process/restore cases. The adapter does not edit or archive records,
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

## Cold native history and ordinary-class process recovery, 21 October 2026

The GET-only history module accepts a clinic-approved patient, original action
and canonical creation window of at most seven days. It includes archived memo/
phone communications, scans at most five pages of 100, and requires two matching
complete inventories. Native collection filters cannot restrict author or
confidentiality, so the preliminary grant covers the whole patient memo/phone
collection in that window; the selected confidential decoded record needs its
own grant. Partial/changed pages, duplicate originals, wrong links, edited content,
unknown key/policy/account and lost current grants stay unavailable/conflicted.
Unrelated human memo text is discarded and never returned. Known-reference and
cold reads share the existing exact native record/codec/MAC parser.

A separate protected original-review reader derives class-booking/movement roots
from the native attendance action ID, and cancellation/rescheduling roots from
the native reviewed-send marker. Its own original-record permission is distinct
from collection and decoded-memo permissions and remains current across the
operation. Source/account/patient/operation/interval bindings are rechecked.
The original review transport checks its own operation's current grant immediately
before native dispatch, after the asynchronous account-budget wait. Concurrent
recoveries do not share a mutable permission callback. Service construction still
validates native configuration before accepting any selection.
The transport and body are owned under a whole bounded lifetime. Invalid or
undefined windows and clocks refuse before native reads; later rollback or
cancellation retires the remaining operation.
No communication ID, ended caller object, lost process map, model assertion or
clinical replay is accepted. A located memo reports historical administrative
facts; it is not a new patient proof or guarantee of the current diary state.

Individual booking deliberately remains unsupported by this original-review
adapter: its review does not retain the actual booking marker. That missing
root needs a separately permitted exact native appointment source, not the
review marker, a fresh UUID or an inferred match. Unknown original selections,
other outcome/process cohorts and combined signed voice remain to be qualified.
A not-located result describes only the declared bounded observation. It never
proves that no effect existed and cannot recreate a spent memo purpose.

Current source controls pass 115/115 (1792586103154,43s), no failures/skips/
cancellations. Two adversarial checks first failed (1792585971835): cancellation
did not retire an abort-ignoring original-review body, and an invalid window
read the review before refusing. Owned bounded body retirement and pre-IO time
validation correct both without weakening the existing review schema or grants.
The full strict/699-output build passes (1792586110481,3m54s,1,656,823,808 B/
2GiB); five new modules/fixtures and two expected changed outputs leave the
other 692 parent outputs unchanged. The first affected strict attempt failed
only on new test narrowing/readonly annotations; corrected strict passes.

The first actual stopped-sender case (1792586377960) reached fresh recovery but
correctly rejected the synthetic transport's localhost Response URL. Privacy/
restore were not reached. Its exact source and699 outputs are privately archived.
Only the test transport envelope was corrected to map its checked native origin
onto the loopback provider, preserving status, headers and abortable body. No
production URL check changed. Affected strict and actual serving rebuild pass
(1792586498246,2m16s,1,086,767,104 B/2GiB): only the recovery-worker output differs;
all 698 other outputs, production and source-control inputs are byte-preserved.

Three actual emitted/PostgreSQL cases now pass, zero failures/skips/cancellations:
stored1/1 (1792586647529) and archived/unretained2/2 (1792586728052). Each executes
the admitted ordinary class session with file approvals, synthetic registered-
channel OTP, played menu/SAM, actual native attendee acknowledgement, the real
SQL180 account/verification budgets and a permanent original-bound memo purpose.
The exact sender process is SIGKILLed after its memo POST but before any response;
its terminal signal and PID absence are verified. A fresh compiled process from
an empty directory receives the clinic-selected review reference, never a memo
ID or action root. It rereads the native review and two complete collections,
finds stored/archived originals, or reports not-located for unretained loss. It
makes no new native mutation and the SQL purpose remains spent in every case.

The complete unfiltered logical database is then restored to a separate fresh
database and the same discovery/one-use checks run in another fresh process.
Every-column and raw full-backup scans pass before and after restore for the
acted-on subject, proof/code/call/session, native review/memo, root, MAC and key.
Legitimate unrelated phone aliases, staged scans and opaque effects are retained;
rich local call rows remain empty. No local patient-bearing recovery queue or
journal is added. Node peaks180,396,032/183,861,248 B and external PostgreSQL peaks
140,574,720/141,324,288 B, each bounded512MiB/CPU100%/Swap0; all OOM/high/max counters
are zero and owned databases/containers are cleaned. Provider, mail, grants and
native retention are synthetic; this is not clinic, carrier or acoustic acceptance.

## Individual-booking marker recovery and final grants, 21 October 2026

A separately permitted clinic-selected native individual appointment now supplies
its actual `Abby booking <UUID>` marker. The review-only owner deliberately still
refuses individual-booking reviews: they omit that marker, and a matching diary
row cannot reconstruct a lost review's causal send identity. The new GET-only
owner accepts an exact appointment/patient and bounded native memo window, with
no communication ID, source UUID, old receipt object or model-authored note.
It is not a new clinical receipt, patient proof or send permission.

The native appointment read explicitly includes archived, cancelled and deleted
states using the three filters supported by the reviewed official contract.
It requires exact self/patient/business/practitioner/type links, canonical bounded
intervals, metadata and marker-only notes, under separate preliminary and decoded-
source grants. Current account/subject/source grants, the real physical budget,
native429 feedback, owned bounded body and whole deadline remain enforced.
History then uses its independent whole-collection and decoded-record grants.
A second exact appointment read must preserve all relevant source/version facts
before final disclosure. Only the authenticated historical booking memo with
that root, appointment and interval can be returned. Cancelled/deleted/archived
state does not erase the historical memo or promise a currently active booking.
Changed intervals/versions, noncanonical notes, copied marker/wrong appointment
and lost source or history permission refuse. Prior source edits are not evidence
of absence; every not-located result stays confined to its declared native source
and complete bounded window, never permission to retry a spent purpose.

A new adversarial check first failed against the earlier review owner
(1792587692669,1 failure): history permission could be withdrawn during the later
original-record permission wait. Both recovery owners now capture history grants
per operation and recheck them across every subsequent source wait and before
returning. Parallel operations do not share these captured queries. Source ports,
physical budget methods, configuration and permission callbacks are captured
before waits. No extra clinical mutation or activation path is introduced.

Current source qualification passes158/158 (1792588396150,1m31s), zero failures,
skips or cancellations, including the new final-grant RED-GREEN case, native
source edits, complete record metadata, held body cancellation, archived and
later-cancelled/deleted records, original-review refusal and existing receipt/
history controls. An initial150/156 run had three positive fixture failures and
three consequent cancellations: the synthetic native GET record omitted its self
link. The complete native metadata and terminal-aware held-test readiness were
corrected; no product link, permission, deadline or assertion was weakened.
The affected driver graph passes (1792588190236). Whole strict TypeScript and the
actual serving build pass (1792588407058,4m07s,1,650,147,328 B/2GiB):700 outputs,
one new recovery module, three expected changed outputs and all696 other parent
outputs byte-preserved. The shared original writer/codec and clinical producers
retain their exact parent bytes.

Six current emitted/PostgreSQL process cases pass, zero failures/skips/
cancellations: the individual stored case1/1 (1792588664958), followed by current
class3 and individual archived/unretained2 cases5/5 (1792588769650). Both sender
families execute their actual admitted owner, file approvals, synthetic registered-
channel OTP, played SAM, original native review, exact clinical acknowledgement
and independent memo. The actual individual native marker is explicitly different
from its review marker. The sender is SIGKILLed after its memo POST and before
response; PID absence and terminal signal are verified. A fresh compiled process
from an empty directory receives only a clinic-selected review/appointment and
protected configuration, with no communication ID or lost source UUID. No fresh
native mutation occurs and the original SQL memo purpose stays spent for stored,
archived and unretained results. The individual native source is also archived
in that archived case.

Each case restores the complete unfiltered logical database into a new isolated
database and repeats discovery and one-use checks in another fresh process.
The real SQL180 and verification budgets, every-column/raw-backup/output privacy,
empty recovery directory and legitimate unrelated aliases/staged scans/opaque
effects are retained. Node peaks212,590,592/182,677,504 B and external PostgreSQL
peaks179,929,088/142,544,896 B, bounded512MiB/CPU100% each/Swap0, all OOM/high/max0.
Owned containers/databases are cleaned. Native provider, mail and grants remain
synthetic. This does not qualify other outcome/process/subject/voice combinations,
real clinic source approval or acoustic/provider acceptance.

## Archived originals and observed-change recovery, 21 October 2026

Historical original reviews now have a distinct `readReviewHistory` entry point.
It explicitly requests `archived_at:*` and validates archive/update timestamps,
exact self/patient/type links and canonical review content. The memo owner
separately matches the full scope, business, credential and selected subject. The
existing `readReview` keeps its active-record URL, result shape and archive
refusal for clinical send/recovery owners. The shared parser has an immutable
per-call mode; a historical read supplies context, never an active send permit.
The memo owner's independent original-record query explicitly includes archived
permission and retains all source/history grants across later waits.

Actual admitted individual cancellation and rescheduling now have cold memo
recovery proof. Their original reviewed-send marker binds the source; the
historical memo retains its `acknowledgedAndObservedBestEffort` grade and full
intervals; rescheduling also retains old/new practitioner references. A later read cannot turn
this into exact causal success or authority to repeat the clinical action.
Completed/archived originals remain readable under separate current permission;
edited canonical intervals, malformed dates and denied source/history grants
refuse without exposing a memo. Class cancellation/movement are not qualified
by these individual-change cases.

Current source qualification passes249/249 (1792590630576,6m02s), zero failures,
skips or cancellations. It includes the earlier booking/history controls, new
closed/archived originals and observed-change source cases, and existing active
class-move/correction/resend staff consumers with real authenticated HTTP checks.
The first run passed209/211 but two preserved staff endpoints lacked this fresh
checkout's dashboard bundle. The actual bundle was built (1792590574531) and its
hash pinned before the complete passing rerun; no assertion or skip was changed.
Whole strict TypeScript and actual serving build pass (1792590648654,4m19s,
1,657,720,832 B/2GiB):700 outputs, four expected changed modules/fixtures, and
all696 other parent outputs unchanged.

The first compiled stored pair (1792591011057) passed rescheduling completely;
cancellation reached cold discovery but its test privacy collector tried to
serialize a nonexistent body after a valid native PATCH204. Its failed driver
is preserved. Only the nonemitted driver was corrected to validate that exact
bodyless cancellation case; full pre/post native appointment snapshots, intervals
and notes were added as privacy canaries. Current affected strict passes
(1792591360004); all700 runtime bytes and selected source249 inputs are unchanged.

Twelve current emitted/PostgreSQL cases pass, zero failures/skips/cancellations:
stored cancellation/rescheduling2/2 (1792591370961), then the other observed-change
and prior individual/class booking cases10/10 (1792591508850). Each actual
admitted sender is SIGKILLed after its memo POST but before response. The parent
retains the actual native review/acknowledgement/inspection and memo, including
closed archived original reviews in archive mode. Fresh compiled workers receive
no memo ID, lost action UUID, receipt object or local cache. They make no native
mutation, retain the spent purpose, then repeat discovery after a complete
unfiltered logical restore into another fresh database. Actual SQL180 and
verification budgets, every-column/raw-backup/output privacy, empty recovery
directories and legitimate unrelated aliases/scans/opaque effects remain.
Node peaks183,529,472/187,670,528 B; external PostgreSQL peaks141,762,560/142,299,136 B,
each bounded512MiB/CPU100%/Swap0, all OOM/high/max0 and owned resources cleaned.
Provider, mail and grants are synthetic; broader subjects, class outcomes,
signed voice and actual clinic/provider acceptance remain separate.


## Actual class cancellation and movement cold recovery, 21 October 2026

The current scoped cohort passes 437 source controls, whole strict TypeScript and 701
serving outputs, plus 36 actual compiled sender-SIGKILL/full-logical-restore/privacy
cases. This extends the prior 12 booking/observed-change cases to ordinary and all three
approved pass-cancellation profiles, and ordinary/same-case-pass completed and partial
movement, each stored, archived and unretained. Cancellation retains acknowledged-and-
observed best-effort truth; a move retains nativeWorkflowReportBestEffort with separate
original/replacement/case association observations. Partial/disposed movement remains
needsReview, with no original cancellation or association sent. This is historical
evidence, never an atomic, financial, current-diary or send-permission claim.

The original two partial probes failed before cold recovery because the separate parent
collector omitted the original attendee returned by native roster reads. Frozen failed
evidence is retained. A separate successor captures actual existing roster/case
responses without new native IO or invented state. The production and fixture inputs to
the 437 source checks stay unchanged; current full strict/701 build changes only the SQL
worker versus the prior 701 outputs, preserving all 700 others. Current 36 cases pass
the corrected witness, renewed-code/case metadata/every-column/raw-dump/output checks,
spent-purpose exclusions and fresh recovery after unfiltered logical restore. Legitimate
unrelated aliases, staged scans and opaque effects stay intact. Real native 180 quotas,
renewed proof and played stage consent remain; only movement test harness deadlines of
600s per child and 660s per case reflect actual waits, with production deadlines
unchanged.

Exact current work IDs: source 1792593213284, full strict/build 1792594624840, SQL
1792594886146(2), 1792595222675(3), 1792594896424(3), 1792595111962(12),
1792595937499(12), 1792595751793(4). Node and external PostgreSQL are independently
bounded at 512 MiB/CPU 100%/Swap 0; whole strict/build 2 GiB. Full process fixtures use
synthetic provider, mail and grants, not real clinic acceptance. Specific cross-
case/uncertain/compensation/native-source and subject/financial/catalogue/signed
incoming/outgoing voice combinations retain their separate scope. Parent integration and
a scoped memo PR with current cloud/review are next; full execution and real acceptance
remain open. No default activation or live traffic.

## Work still required

The current individual/class source producers and partial movement reports have
local scoped qualification. The signed incoming adult-representative individual-booking subset is qualified below. The guardian booking/individual-change subset now has scoped qualification below. Multi-subject/other-operation/class, financial, catalogue and other signed incoming/outgoing voice combinations remain separate.
Keep known clinical acknowledgement irrevocable after memo quota, permission,
source, observer or response failures.
Exact clinic templates, local presentation, author, confidentiality/viewer roles,
retention and per-operation permissions remain separate requirements.

Extend the now-qualified history and scoped booking/change/class process/restore subsets to remaining source/subject and explicitly unqualified class variants. Retain all-column/raw-
backup privacy, archived/ambiguous refusal and real physical-budget admission.
Then qualify the actual combined host/serving paths, keep operator facts and
scenarios current, and complete normal parent integration, exact-head cloud
checks and review before publication. The recorded memo component was qualified on PR576/main1c. The local integrated candidate now includes normally merged outbound PR575/577; current local combined qualification is recorded below; own exact-head cloud checks and review remain pending. Attachments and
other storage types stay separate.

Outbound complete no-stop/private/all-ASR reporting and real acoustic/provider/
clinic acceptance remain open. Independent memo engineering does not close or
bypass those execution-stage requirements or the full thirteen-gap goal.

## Combined memo review and dispatch-permission correction, 21 October 2026

The local memo stack incorporates normally merged outbound parents through PR577.
On the frozen 2fbf snapshot, the deduplicated combined 60-file source regression
passed 1,198 tests (1792597347750), whole strict/717 serving passed
(1792597023425), and class-cancellation recovery passed all twelve cases
(1792597369686). These are specific snapshot results, not qualification of the
subsequent correction or the full roadmap.

Spec review identified a protected-read timing gap: withdrawing the original
review grant during the asynchronous account-budget wait still allowed its GET
before later checks withheld the result. Both local regression cases reproduced
that GET (1792598289156, 0/2); no real clinic was contacted. The correction checks
current permission inside deferred native dispatch and gives each recovery its
own reader/closure, retaining eager configuration validation. A second concurrent
recovery cannot grant the revoked operation permission. Corrected source 1,200, full strict/717 serving and all 36 scoped killed-sender/restore/privacy cases now pass locally. See [the current integrated evidence](COMMUNICATION_MEMOS.md#permission-corrected-integrated-qualification-21-october-2026). The review's
optional canonical-envelope duplication cleanup is deferred; no payload bytes or
clinical outcome semantics change. Own PR/cloud review and actual clinic grants
remain required. Default wiring is inactive; the full execution goal remains open.

## Permission-corrected integrated qualification, 21 October 2026

On the actual normally merged PR575/577 parent, the current corrected combined
60-file source regression passes 1,200/1,200 (1792598419523,9m30s,peak 287,223,808 B/
512MiB), zero failures/skips/cancellations. The two revoked-budget/concurrent-call
controls first reproduced an unauthorized synthetic original GET (1792598289156,
0/2) and now pass. Focused read-only spec follow-up confirms the dispatch guard,
per-invocation closure and eager validation; optional codec duplication cleanup
remains deferred.

Whole strict TypeScript and actual serving compilation both pass
(1792598420978,3m54s,peak 1,672,601,600 B/2GiB). The wrapper's later inventory guard
failed because it incorrectly expected a contract test to emit; that file is
not a serving entrypoint. An independent exact 717-file inventory/source-hash
check corrected the expected set without rebuilding or rewriting failed evidence.
Only the original-review recovery module differs from integrated `2fbf`, with all
other 716 outputs byte-preserved. No compiler/product failure or extra output is
hidden by that guard correction.

All36 actual emitted killed-sender/fresh-GET-only-process/full-logical-restore/
privacy cases pass with zero failures/skips/cancellations:
1792598706713(pass complete3),1792598708190(class cancellations12),
1792599043019(partial archived/unretained4),1792599133055(preserved booking and
individual changes12),1792599134468(ordinary complete3),1792599135917(partial
stored2). Every case retains native180/verification quotas, renewed proof/played
stage approval where required, permanent spent purposes, complete unfiltered
restores and all-column/raw-backup/output privacy while preserving legitimate
unrelated aliases/scans/effects. Node and external PostgreSQL each have 512 MiB/
Swap0 caps; the latter three short cohorts use 50% CPU each, earlier cohorts 100%
each, with fresh actual admission and unchanged test/production deadlines. Owned
databases/containers are cleaned. Native services, mail and clinic grants remain
synthetic. This scoped result does not qualify other subjects/representatives,
financial/catalogue/actual signed incoming/outgoing voice, complete no-stop/
private/all-ASR or real clinic author/viewer/retention/source/restore acceptance.
Own exact-head cloud/review and normal merge remain required. No default mounting,
live traffic or completed thirteen-gap goal is claimed.

## Signed adult representative booking memos, 21 October 2026

The separate follow-up to draft PR578 qualifies an incoming adult representative
booking through the actual reusable clinical host and signed HTTP/WebSocket
serving composition. The caller and selected patient receive separate registered
channel challenges. Private identity fields never become ordinary model turns;
played patient readback and booking consent precede the one native creation.
The native receipt and private dispatch bind the memo to that selected patient,
never the verified caller or another related person. Other patient grants and
withdrawn memo permission suppress only memo retention; the known booking stays
confirmed. Stored memo response loss remains uncertain, with a spent SQL purpose
and no additional clinical write or memo POST when the caller asks for its outcome.

Current source controls pass 55/55 across 11 files (1792601160370,5m10s,peak151,691,264 B/
512MiB), including the new owner controls, existing representative selection/
workflow/change/task checks and canary safeguards. Full strict TypeScript and
720 serving outputs pass (1792601161819,4m04s,peak1,684,189,184 B/2GiB).
A subsequent affected strict/serving rebuild passes (1792601621814,2m20s,
peak1,146,761,216 B/2GiB), and the final nonemitted SQL driver graph passes
(1792601830276,1m18s,peak860,438,528 B/1GiB). Only two test-helper outputs differ
from the 717 parent, with three added fixtures; all production and the other 715
parent outputs match. Source55 dependency bytes stay unchanged across the
unreferenced signed-fixture/nonemitted-driver overlay; no fresh wider source
count is inferred.

The first emitted accepted probe failed at host construction (1792601468726):
the fixture omitted the reusable host's required private representative
transcription factory. No caller/native/memo/privacy assertion was reached.
The correction shares the same existing private factory between host and fixture
composition. It changes no production guard. Earlier private-config types failed
only to resolve Node declarations; explicit prospective typeRoots corrected it.
All failed runners and source/output pins are retained.

Four actual emitted signed/PostgreSQL cases pass: accepted 1 (1792601828832,30s)
and wrong-patient-grant/withdrawn/lost-stored-ACK 3 (1792601970053,54s), zero
failures/skips/cancellations. The actual account SQL180 budget, real caller and
patient verification budgets, permanent memo purpose and whole deadlines remain
active. Source time follows real elapsed time; the memo clock additionally uses
the serving fixture's actual media/source clock. Provider, mail, clear-final ASR
and clinic grants remain explicitly synthetic.

Distinct native canary patient IDs are configured before relationship/selection
setup, preserving existing default fixture identities. After actual call cleanup,
every-column and unfiltered full-backup scans cover caller/subject IDs, private
names/dates/emails/phones/ASR fields/codes, verification/call/session refs, native
review/source roots, memo payload/MAC and key. Model/transcript/intent and actual
command-progress projections are checked separately from private internal
clinical state. Legitimate unrelated phone aliases, staged scans and opaque
effects remain in the complete database/backup. Node and external PostgreSQL
have separate 512 MiB/CPU100%/Swap0 caps and all OOM/high/max counters stay zero;
owned databases, containers and private fixture folders are cleaned.

Review of local `07dd800` found one P2 evidence gap: the denied-retention
modes obtained the native source marker only from memo POSTs, which they
correctly suppress. Those earlier four passes do not cover that missing canary.
The nonemitted driver now independently observes the actual native booking notes,
requires their exact UUIDv4 marker in every mode, probes both full notes and marker
in public output, every SQL column and the unfiltered raw backup, and requires any
posted memo sourceActionRef to equal the independently observed native marker.
Read-only spec follow-up confirms the finding is closed without weakening scope;
Standards review found no breaches or actionable smells.

The corrected complete four-mode emitted signed SQL/privacy run passes
(1792602775930,54s; Node peak168,853,504 B and PostgreSQL peak127,062,016 B,
separate512MiB/CPU100%/Swap0 caps; zero OOM/high/max events).
Affected strict TypeScript also passes (1792602777380,1m15s).
All720 runtime outputs and the selected55 source-test dependency bytes remain
unchanged. These four current cases supersede the earlier SQL privacy witness
for this driver; they are not four additional acceptance scenarios. Historical
results and the original review remain preserved.

This adds no guardian, representative cancellation/rescheduling/class, financial,
catalogue or outgoing voice qualification. It adds no stopped-process or restore
case; the parent's 36 restored-history cases retain their recorded scope. Real
clinic author/content/viewer/retention, permission/source/restore, provider/mail
and acoustic acceptance remain open. Actual normal parent integration is recorded below; this follow-up's
own publication/exact-head cloud/review remain required before delivery. No default activation
or completed thirteen-gap goal is claimed.

## Normally merged memo parent and subject qualification integration

PR #578/exactd72dd74 passed all eight push/PR jobs; complete raw logs are
archived. It normally merged as main7a539010914c846b006222717f14c254aab7f1f4
at17:32:19UTC. That actual main tree exactly equals the qualified d72 parent;
this signed representative-booking follow-up now incorporates the normal merge.
Only reviewed documentation status changes: all qualified code, runtime inputs,
dependencies, emitted roots and720 artifact hashes stay unchanged. Current55
source controls and four independently canaried signed SQL cases retain their
recorded scopes; no rebuild, duplicate runtime run or broader acceptance is
inferred. Fresh facts/scenario/source/naming/artifact/cleanup guards precede
this follow-up's own publication and exact-head cloud/review. Actual merged-main
checks are separately tracked and are not inferred green from the PR's checks.
The full thirteen-gap objective and actual clinic/provider/mail/acoustic/source/
restore acceptance remain open. No default activation or live traffic.

## Signed outgoing original-patient administrative memos, 21 October 2026

Earlier local637534b qualified the optional outgoing prepared-clinical composition
for original-patient follow-up individual booking and exact sick-day individual
cancellation/rescheduling. Actual signed HTTP/WebSocket greeting, private keypad
verification, played clinical confirmation and native receipt/observation precede
independently granted memo retention. Every posted memo identifies the verified
original patient and actual outbound direction; booking uses the independently
observed native booking marker, while observed changes use the strict original
review marker. Those native roots are independently privacy canaries even when
the memo grant is denied. These tests do not release a contact or call-capacity
hold or establish complete no-stop/private/all-ASR finality.

For each operation, accepted retention, wrong-patient producer grant, withdrawn
memo permission and stored-but-lost memo acknowledgement are exercised. Denial
suppresses retention without erasing known clinical success. Lost memo ACK stays
uncertain; duplicate queries cannot repeat the clinical mutation or one-use memo
purpose. Cancellation/rescheduling retain acknowledged-and-observed best-effort
meaning. This adds no financial, atomic-diary or appointment-capacity promise.

Current source work1792603533927 passes48/48 in six files (2m25s,
peak170,172,416 B/512MiB): the twelve new signed cases plus existing outgoing
clinical/cancellation/financial, representative memo and verification-code
canary controls. Whole strict TypeScript and actual721-output serving build pass
(1792603535383,3m39s,peak1,693,466,624 B/2GiB). Relative to the qualified720
parent, only the outgoing voice and verification-code test helpers change, with
one added shared outgoing-memo fixture. Every production output and the other718
parent outputs are byte-identical. New fixture options have actual source/SQL
consumers; earlier callers keep their original defaults. The new paths opt into
real elapsed wall time alongside the fixture's actual media clock.

Only the nonemitted SQL driver was refined afterward to probe independent native
context UUIDs, carrier secrets and memo MACs rather than relying solely on whole
payload canaries. Its affected strict graph passes (1792603796475,58s,
peak686,026,752 B/1GiB). All721 outputs and selected48 source dependencies remain
unchanged; no duplicate build/source run is claimed. The initial inline signed
three-operation smoke and affected types passed before shared-helper extraction
and these SQL/clock refinements; they are preserved as historical prototypes.

Actual emitted signed/PostgreSQL work passes all twelve cases: accepted3
(1792603795020,37s) and remaining wrong-grant/withdrawn/lost-ACK9
(1792603888177,1m04s), zero failures/skips/cancellations. Each case owns a fresh
migrated database and uses the real native180 account budget, actual SQL
verification quotas, call-session exclusion and permanent memo purpose. Public
projections, every SQL column and an unfiltered complete raw backup are checked
for private input/identity/contact, proof/call/session, actual native source roots,
original routing context/UUIDs, carrier keys and memo payload/MAC/key material.
Legitimate unrelated phone aliases, staged scans and opaque effects remain.
Node and external PostgreSQL have separate512MiB/CPU100%/Swap0 caps; peaks are
165,490,688 B and170,573,824 B for Node across the two runs. All OOM/high/max
counters are zero, and owned databases/containers/fixture folders are cleaned.
There is no new process kill or logical-restore case in this cohort.

Clinic/native/carrier/mail, clear-final ASR and grants remain synthetic. Guardian,
representative/class/financial/catalogue combinations, outgoing clinical-response
uncertainty, complete negative finality and actual clinic/provider/acoustic/source/
restore acceptance are separate. PR578 normally merged after eight green jobs;
actual-main checks remain independent. Representative PR579 is published and
still has its own current cloud/normal-merge gate. This local follow-up integrates
that exact parent with qualification inputs preserved, but remains unpublished
until its actual normal parent and own review/cloud gates. No default activation
or completed thirteen-gap goal is claimed.

## Outgoing clinical-response uncertainty, 21 October 2026

Current qualification additionally covers clinical response loss in actual signed
outgoing booking, cancellation and rescheduling. Each synthetic native endpoint
performs its mutation before losing the response. Abby retains uncertainty and
writes no memo or memo purpose. A separately budgeted diagnostic GET verifies
that the native change exists, without supplying that observation back to Abby;
a later caller outcome question still cannot promote the result or repeat either
clinical or memo writes. Existing known acknowledgements remain committed despite
the separate denied or lost memo-retention outcomes.

The first three-case probe passed booking and failed two diagnostic-oracle calls
(1792605054418,1/3): those calls omitted the base fixture's required redirect
refusal. Clinical uncertainty/no-memo checks preceded the diagnostic failure.
The oracle now charges the same physical budget and supplies redirect:error,
the normal Basic/User-Agent/Accept headers and a bounded signal; no provider
assertion or production guard is removed. The corrected three-case source probe
passes (1792605152940). Failed inputs, runner and log remain frozen.

Current full six-file source qualification passes51/51 (1792605200405), zero
failures/skips/cancellations. Whole strict TypeScript and actual721 output rebuild
pass (1792605201842,3m48s,peak1,663,459,328 B/2GiB). Only outgoing-clinical-voice
and outgoing-memo test helpers differ from637534b; all production and the other719
outputs remain byte-identical. No unqualified source/artifact overlay is used.

All fifteen current emitted signed/PostgreSQL cases pass: clinical-response-loss3
(1792605494854,34s,Node peak158,371,840 B) and preserved known-clinical12
(1792605583624,1m41s,Node peak178,847,744 B). The actual 180 budget, SQL verification,
session exclusions and permanent memo purposes remain active. Diagnostic reads
are explicitly charged; no limit, deadline, scanner or failure assertion changes.
The same every-column and complete-unfiltered-backup/output privacy probes retain
independent native markers/context/keys/proof/call/session canaries and unrelated
legitimate aliases/scans/effects. Node and external PostgreSQL remain separately
bounded512MiB/CPU100%/Swap0; all OOM/high/max counters are zero and owned resources
are cleaned. This is one current fifteen-case scope, not a sum with the earlier
twelve. No new killed-sender or logical restore is claimed.

Remote services, clear-final ASR and grants remain synthetic. Representative
PR579's actual normal merge and this follow-up's current review/publication/cloud
remain separate gates. Broader subjects/classes/financial/catalogue combinations,
complete no-stop/private/all-ASR and real clinic/provider/mail/acoustic/source/
restore acceptance stay open. No default activation or completed execution goal.

## Signed representative individual changes, 21 October 2026

This test-only follow-up qualifies the optional incoming adult-representative individual cancellation and rescheduling composition, alongside the preserved original-patient outgoing memo cohort. Caller and selected patient receive separate registered-channel codes; current independent authority, public menus and actually played SAM precede the one native change. The memo is confidential and bound to the selected patient and original native review marker, never the caller or another related patient.

Both operations cover accepted retention, another-patient producer grant, withdrawn memo permission, stored memo with lost ACK and lost clinical ACK. Independent memo denial or uncertainty cannot erase a known clinical outcome. A lost clinical response remains uncertain/needsReview with no memo or consumed memo purpose, even when a separately charged diagnostic observes matching native state. The clinical action and spent memo purpose cannot replay. Source controls also preserve truthful uncertainty when an accelerated reschedule exhausts its actual 180-request rolling window after its one PATCH.

The historical representative-change checkpoint used 71 actual source controls across 9 disjoint files on one frozen source graph:32 representative/permission/canary controls (1792607862760) and39 outgoing controls (1792608037975), zero failed, cancelled or skipped. This was a deduplicated union at that checkpoint, not a sum of historical component claims. The [current combined qualification](#combined-guardian-patient-task-and-class-memo-qualification-21-october-2026) supersedes its current-status summary while preserving these exact recorded results. Whole strict TypeScript and 722 serving outputs pass (1792607864205,4m15s,peak1,695,264,768 B/2GiB). From the prior 721 outputs, only the finite direct-SQL verification-canary test helper changes and representative-change-call.js is added. All production bytes and the other 720 outputs are exact.

The historical compiled signed SQL cohort contained 25 distinct cases: 15 preserved outgoing cases (1792608235090) and 10 representative cancellation/rescheduling cases (1792608800588). Each uses fresh migrated disposable PostgreSQL, the actual shared native180 budget, persisted caller/patient verification accounting, permanent memo exclusions and the real signed HTTP/WS/reusable clinical host. Every-column and unfiltered full logical-dump privacy include independent native source markers and context, separate private codes/identities, memo content/MAC/key and transport credentials; legitimate unrelated index/staged-scan/effect state is retained. The earlier1-case paced accepted smoke is not added to the25.

Positive paced reschedules keep actual elapsed time, normal session renewals and steady20ms carrier silence advancing under the existing two played pause notices and a presence turn. They ask for a current target range; no quota, stale-turn, silence, lease, proof, policy, action or memo deadline is weakened. Earlier failed probes retained wrong decoded-review and private-state/public-receipt assertions, accelerated quota exhaustion, an unrenewed direct fixture lease, a stale initial search range and a signed caller that waited without advancing carrier frames. These are preserved failures, not a release claim. Fixed-stage diagnostics expose codes/counts/timing and existing public workflow state, never private identities or native rows. The final nonemitted SQL-driver correction keeps all 71 selected source dependencies and 722 runtime bytes unchanged and passes its affected strict check (1792608640535).

PR #579 normally merged as main 9f242cde after all eight exact-fbf2 jobs passed and full raw logs were archived; its actual merged-main checks remain independently tracked. This follow-up integrates that normal parent with every qualified source/runtime byte preserved. Delivery remains subject to current facts/scenario/naming/source guards, separate Standards/Spec review, its own publication and exact-head cloud jobs. Remote Cliniko/carrier/mail/ASR and clinic grants remain synthetic. No new sender SIGKILL or logical restore is claimed here. Guardian, multi-subject/class/financial/catalogue variants, complete no-stop/private/all-ASR and real clinic/source/carrier/mail/acoustic/retention acceptance remain open. No deployment or default activation follows.

## Signed guardian administrative memos, 21 October 2026

The new concrete guardian fixture changes the selected patient's native date of birth and independently clinic-approved authority together. Caller words never supply guardian authority. The existing adult representative remains the default. Both paths separately verify the caller and selected patient's registered channel, use actual protected menus and played confirmation, and require independent current memo grants. A memo binds the actual native source, patient and inbound direction.

Booking covers accepted, another-patient grant, withdrawn memo permission and stored-but-lost memo ACK. Individual cancellation/rescheduling additionally covers a native mutation with a lost clinical response: truthful uncertainty, no memo/purpose or replay, even after an independently charged native diagnostic matches. A source-only fast reschedule preserves uncertainty after real rolling-window exhaustion. Known clinical success survives denied or lost memo retention.

The 66 direct source controls passed before the SQL-only entrypoint refinement (1792610195449). Their authority/memo test bodies and dependencies remain exact, except for two finite SQL-only canary entrypoint additions. Current canary/context controls pass 8/8 (1792611872496); they are not added to 66 as new distinct source coverage. Current whole strict TypeScript and actual 722 serving compile commands returned 0 (1792611878191); the separate final source/artifact audit passes (1792612154203). Only representative-call-owner.js and verification-code-canary.js differ from parent 37dd's 722 outputs; every production and other 720 output byte is exact.

Current unfiltered normal test entrypoints pass all 28 distinct actual emitted signed PostgreSQL/privacy cases: adult 14 (1792612169405) and guardian 14 (1792612175687), zero skips/failures/cancellations. Shared case-definition helpers supply separate adult and guardian booking/change entrypoints, so the ordinary coordinator uses the same process boundaries. Each child retains the unchanged 600s synthetic canary window, actual rolling 180 budget, separate SQL verification owners and permanent memo exclusions. Every-column and complete unfiltered logical-backup scans, unrelated state preservation, frozen source/artifact/dependency pins and owned database cleanup remain required.

The initial expanded single-file run (1792610464584) naturally finished 25 passed/3 failed: the late guardian rescheduling cases exceeded their declared synthetic canary window before final privacy scans. That evidence is retained and supplies no pass for those checks. Intermediate anchored selections each passed 14 with zero skipped cases, but are not added to 28 or substituted for the current unfiltered normal-entrypoint runs. Both sets of strict/build commands passed, while their frozen wrappers failed afterward: the first expected a runtime delta from a type-only edit, and the second referenced a nonexistent renamed parent baseline manifest. Both failures remain unchanged. Independent actual-delta/source audits verify the completed outputs against the preserved real parent baseline; the final tracked audit passes without another rebuild. No scanner exemption, wider canary window, raised application quota, extended proof/action deadline or simulated rolling-window clock was introduced.

All clinic/native/mail/ASR/carrier services and grants are synthetic. Native age/guardian-policy refusals retain the existing selection controls. This adds no multi-subject sequence, representative class/financial/catalogue combination, new sender process-loss/restore or real clinic acceptance. Other note types and attachments remain unselected. Current facts/scenario guard, separate reviews, actual normal parent #580 integration and own publication/cloud/normal merge remain required. No deployment or default activation follows.

## Signed-call media epoch regression, 21 October 2026

The original PR #580 head37dd909 passed its four PR jobs but its push PostgreSQL job failed the representative cancellation lost-memo-ACK case: the clinical change was committed while optional memo retention reported unavailable instead of uncertain. All seven successful job logs and the complete failure log are preserved. Passing jobs on the other workflow do not qualify that failed head.

Ordinary exact-head repetitions and private fixed-stage diagnostics did not reproduce it. A controlled received-media regression did:24 quiet batches advanced12seconds of synthetic carrier media before confirmation, with the original lease, proof, played confirmation,180quota and memo deadline intact. Work1792615156821 reached the actual acknowledged review and inspected native change with no budget denial, but the observation was76ms before review creation; the producer correctly refused that provenance. This is direct local evidence of the matching failure, not a retroactive measurement of the uninstrumented cloud stage.

The fixture had measured media from fixture creation while TwilioMediaStream measures it from authenticated stream admission. Its source clock now takes that actual stream.streamStartedAt epoch in createCall, preserving max(source time, media time) and counting real waits once. No production file, receipt, gate, expected outcome, native quota or deadline changes. The same cancellation case retains the accelerated received quiet batches, then checks clinical commitment, uncertain memo ACK, one actual memo row, its permanent consumed purpose, no replay and every-column/full unfiltered backup privacy.

Current frozen qualification:71 source controls across the same9 disjoint files (1792615231652), full strict TypeScript and722 rebuilt outputs (1792615230213), ten normal-entrypoint signed representative change cases (1792615427045) and nineteen preserved outgoing/representative-booking cases (1792615428987). All source/SQL cases have zero failures, skips or cancellations;29SQL names are distinct. The regression is included in those ten, not added again. Only cliniko-workflow-voice.js changes from the original722 artifacts; all production and the other721 outputs are exact. Each SQL cohort uses isolated disposable PostgreSQL, the actual180 account budget, verification and permanent-purpose storage, and retains legitimate unrelated index/staged-scan/effect data. Full raw cloud failure and earlier failed/red evidence remain historical evidence.

Actual main579 has separately passed all four checks with full raw logs archived. The correction still requires its own current review, fresh exact-head push/PR cloud, normal merge and independently checked actual main; old seven-green evidence cannot qualify it. Guardian/multi-patient and other combinations remain separate. Full thirteen-gap, complete no-stop/private/all-ASR, real clinic/source/carrier/mail/acoustic/retention and restore acceptance remain open. No live traffic, default activation or deployment follows.


## Guardian memos with corrected stream timing, 21 October 2026

The initial6721176 guardian checkpoint and all earlier66/8/28 qualification, wrapper and canary-window failures remain preserved. The parent998341d correction is locally integrated without changing production or guardian authority. The shared signed-call fixture is byte-identical to that reviewed parent and uses the decoder's authenticated stream epoch. Both adult and guardian lost-memo-ACK cancellation cases now include the same24 received quiet batches before played confirmation. Original expected uncertainty, known clinical success, permanent exclusion and all privacy scans remain unchanged.

Current fresh qualification passes66/66 source controls across8 files (1792616231066,14m14s), including the8 existing canary controls; these are not66 plus8. Whole strict TypeScript and722 rebuilt outputs pass (1792616229658,2m29s). Compared with corrected998, only representative-call-owner.js and verification-code-canary.js differ; every production and other720 output byte is exact. Case-body reconstruction independently proves that the factored normal test definitions preserve all earlier assertions; the only new body delta is the reviewed received-media regression.

Both unfiltered ordinary-entrypoint PostgreSQL cohorts pass:adult14 (1792616424068,7m08s) and guardian14 (1792616426039,7m07s),28 distinct case names with zero failures, skips or cancellations. They use the current source/runtime/dependency pins, actual native180 budget, independent caller/patient verification, permanent memo exclusions, every-column and complete unfiltered backup privacy, and preserve unrelated index/staged-scan/effect data. Owned containers and database slices were cleaned. These runs replace the current qualification; they are not added to historical cases.

The first new metadata collector incorrectly expected68 source cases; the actual complete TAP run contains66, with the8 canary tests already included. The corrected collector uses the unique actual66 names and original exit/log hashes. No tests, assertions or historical results were altered or repeated to fix that bookkeeping error.

Actual main579 has four independently green/raw-archived checks. Corrected parent PR580 is still undergoing its own exact-head cloud qualification. This local successor still needs current review, actual normal parent580 integration, publication, its own cloud/normal merge and independently tracked actual main. The earlier672 review does not qualify a changed head. Broader multi-patient/class/financial/catalogue and real clinic/source/carrier/mail/acoustic/retention/restore acceptance remain separate; no full-gap completion, deployment or activation.


## Consecutive patient booking task memos, 21 October 2026

This test-only component exercises the existing independently approved patient-task sequence through two separate bookings. The first subject is an adult representative case; the second is a native minor with separately clinic-approved guardian authority. Both callers/subjects receive fresh registered-channel proof before their own mutation. The second task cannot inherit the first subject's verification or memo permission. Protected menus, played confirmation, actual native booking markers and independent current memo grants remain mandatory. No batch mutation or new production capability is introduced.

Six new cases cover two accepted memos, first-patient denial, second-patient denial, both memo acknowledgements lost after actual storage, a first clinical acknowledgement lost, and a prior memo still pending when the next workflow starts. Known clinical outcomes survive memo denial/uncertainty. Lost clinical ACK blocks a new task with no memo or consumed memo purpose. The pending case starts an unverified next workflow without sending another booking; after the original owner closes, the released memo still retains its first patient and source. The completed first clinical action remains unchanged.

The shared memo fixture retains its original single-subject default and adds a concrete two-subject tuple for these tests. Native memo rows have distinct references. The extracted task fixture preserves its five existing task tests and has a concrete supplied caller/memo/clock consumer. Test-only pending-entry observation is bounded by the existing5s memo lifetime, and raw native UUIDs are included in source privacy canaries. No production file, expected outcome, quota, permission or deadline changes. The authenticated stream epoch and parent cancellation regression remain exact.

The historical patient-task component passed 42 distinct controls across 5 files:34 task/memo/preserved source controls (1792616615613) and8 canary/isolation controls (1792617086847), with no overlaps, skips or cancellations. Full strict TypeScript and722 serving outputs pass (1792616614200). Only subject-memo.js and verification-code-canary.js differ from the corrected guardian baseline; every production and other720 output byte is exact.

Historical unfiltered normal-entrypoint PostgreSQL qualification passed 6 new signed cases (1792616889945) and8 preserved adult/guardian single-subject booking cases (1792617456965),14 distinct cases total. The four sequential cases use real61s pacing with ordinary renewals, presence and20ms carrier frames; the pending/uncertain cases use a separate normal child. All use native180, real verification accounting and permanent memo exclusions. Every-column and complete unfiltered logical-backup scans cover private identities, long subject IDs, both code/proof pairs, native notes/markers/context, memo content/MAC/key and transport/call/session material. Unrelated index/staged-scan/effect state is retained, and owned databases/containers/slices are cleaned. Original historical34-source evidence is preserved separately and is not added to42.

At this historical component checkpoint, the reviewed local guardian parent was 7245b44 and its parent PR580 was still in exact-head cloud qualification. The recorded component gates were facts/scenario/naming/source guards, reviewed-parent integration, review and eventual normal parent/publication/cloud/merge. The [current combined qualification](#combined-guardian-patient-task-and-class-memo-qualification-21-october-2026) records the superseding 199-source/73-SQL graph and actual normal parent, keeping its own publication/cloud/merge gates explicit. Parent28 guardian SQL cases are not claimed as current cases in this expanded fixture graph. Other patient operations, class/financial/catalogue combinations, complete no-stop/private/all-ASR and real clinic/provider/mail/acoustic/source/retention/restore acceptance remain open. No new sender kill/restore or activation/deployment is claimed.


## Bounded SQL verification canaries, 21 October 2026

Parents through PR #579 retain normal-merge evidence and independently green actual main9f242cde. PR #580 correction998341d passed four push jobs but its PR PostgreSQL job failed a different privacy-fixture case: the six-digit verification-code canary matched a legitimate request timestamp. Seven green jobs and the complete failure are archived; the head is not fully green. A controlled actual-clock/code-issuer witness reproduces the same scanner label/column without inserting a secret or changing timestamps. This next correction gives each case in five memo SQL suites a pre-issue bounded clock-canary scope and restores the original generator after its owner closes. Seventy-two source controls across9 disjoint files, including9 isolation/lifecycle controls, whole strict TypeScript/722 serving outputs and84 distinct normal-entrypoint PostgreSQL/privacy cases pass:55 affected individual/class memo cases plus29 preserved signed representative/outgoing cases. Only the test canary output changes relative to998; every production and other721 output byte is exact. The original code issuer/hash/salt/proof flow, native180, all quotas/deadlines, every-column and full unfiltered backup assertions remain. Current review, same-PR fast-forward publication, fresh exact-head cloud, normal merge and actual-main checks remain delivery gates. Guardian, multi-patient, further signed class/financial/catalogue combinations, complete no-stop/private/all-ASR and real clinic/provider/mail/acoustic/source/retention/restore acceptance remain separate. No deployment or activation. See [the canary correction and evidence](COMMUNICATION_MEMOS.md#bounded-sql-verification-canaries-21-october-2026).

The actual998 PR failure is the reschedule/clinicalResponseLost case in postgres-appointment-change-memo.test.ts: label change_memo_3_0 matched cliniko_request_budgets.sent_at_ms. That label is the original raw six-digit verification code; the budget owner obtains these values from PostgreSQL clock_timestamp(), not patient input. The successful push does not qualify the failed PR workflow. Full raw failed-job119479556093 and seven independently green logs remain archived.

Controlled work1792620290785 selected a code from the actual PostgreSQL clock prefix before the actual issuer/salt, delivery and proof path, with every original request, row, timestamp, expected clinical outcome and scanner assertion intact. The original case failed at that same label/table/column. This establishes the reproduced ambiguity; the uninstrumented cloud intentionally did not retain its private code or row values, so no exact private-value reconstruction is claimed. The controlled-draw diagnostic was removed before the correction and qualification.

The existing clock-disjoint synthetic sampler now has an owned per-case interface for five concrete SQL files: individual booking, observed individual changes, class booking, class cancellation and class movement. Each snapshots legitimate prior request-clock substrings before its current challenge and uses the same bounded600s future/60s lookback window and bounded rejection sampling, including the existing microsecond-fraction rule. The window belongs to the test case, so a long unfiltered file can run several independently bounded cases without extending an application deadline or weakening its canaries. No post-issue rows or current secret can enter the exclusion snapshot to suppress a later leak.

The helper restores the exact default and named crypto issuer after the actual fixture closes. Nested installation refuses, close is idempotent, and an old closed scope cannot overwrite a newer one. Only the five finite file contexts are added to the existing isolated Node-child/localhost/test-database guard. Nine current source controls include an actual isolated child exercising install/draw/restore/reinstall and unrelated-worker refusals. Production code generation remains unchanged; its actual hash/salt/delivery/verification and SQL attempt budgets still run in each fixture.

Current normal unfiltered SQL qualification contains55 affected cases:booking5, observed changes13, class booking12, class cancellation15 and class movement10. All29 preserved legacy whole-child cases also pass:representative changes10, representative booking4 and outgoing15. The84 actual names are distinct; the9 isolated controls are included in72, while previous71 and other component counts are not added. Original canary arrays, every-column and complete unfiltered raw/COPY/JSON backup checks remain, as do native180 accounting, permanent exclusions, original acknowledgements/outcome assertions, real quota waits and all lease/proof/action/memo/test deadlines. Existing legitimate aliases, staged scans and opaque effects remain, and owned databases/containers/slices are cleaned. This is no new clinic, source, sender-kill or restore acceptance.

Actual proof work: source=1792621520047, isolatedSubset=1792620513223, build=1792620540870, bookingSQL=1792620950480, changesSQL=1792620803509, classBookSQL=1792620769944, classCancelSQL=1792620757313, classMoveSQL=1792620744617, legacySQL=1792621078974. Only verification-code-canary.js differs from the original722 outputs; all production and other721 bytes are exact. Existing stream-epoch correction and accelerated received-media cancellation regression remain exact. Current facts/scenario/naming/source/artifact/cleanup guards and separate Standards/Spec review precede plain fast-forward publication to the same PR580. Fresh own-head cloud, normal merge and independent actual-main checks remain required; earlier seven-green evidence cannot qualify this new head. The separately qualified local guardian/task/class graph remains unpublished and must integrate this reviewed correction and requalify before its own combined follow-up. Full thirteen-gap scope and real acceptance remain open.


## Combined guardian patient task and class memo qualification, 21 October 2026

The guardian, independent patient-task and signed self class memo checks now share one qualified graph: 199 distinct source controls across17 files, whole strict TypeScript/722 serving outputs and73 distinct actual emitted signed PostgreSQL/privacy cases (adult14, guardian14, consecutive patient tasks6, outgoing15 and self ordinary/pass class creation8 and self class cancellation16). Independent patient proof and memo grants preserve the original native subject/action across denied grants, clinical uncertainty and pending prior retention. Pass capacity waiting uses real elapsed time, quiet20ms carrier frames and a fresh affirmative. Reviewed per-case canary correction c39017f is integrated; the finite filename guard retains all guardian/task/class contexts. Only four test-helper outputs differ from c390: class-call-flow, representative-call-owner, subject-memo and verification-code-canary. Every production and the other718 output bytes are exact. Corrected parent PR #580 normally merged at d37cb90e8fce after its own eight exact-head cloud checks and complete raw-log archive; its actual-main checks are independent. Current combined review, own publication/cloud and normal merge remain gates. This covers separate booking tasks and self class creation plus ordinary/approved-pass cancellation. Class creation uses an approved notRequired financial assessment; a pass proves no payment, fee waiver or refund. Representative classes, required financial/catalogue and signed class movement combinations, complete no-stop/private/all-ASR and real clinic/provider/mail/acoustic/source/retention/restore acceptance remain open. No deployment or activation. See [the combined evidence](COMMUNICATION_MEMOS.md#combined-guardian-patient-task-and-class-memo-qualification-21-october-2026).

Previously reviewed guardian7245b44 and patient-task e616214 components and the signed class source checkpoint02a982 are incorporated into one coherent test-only follow-up. Their separate proof remains historical; none is claimed separately published or merged. The former composed111/57 graph is also preserved separately. After integrating c390, all199 source controls and all73 signed SQL cases were run again on the actual combined graph. Component66/42/27 counts and parent72/84 counts are not summed.

The eight signed class cases use the actual emitted owner, signed HTTP/WebSocket/media admission, registered-channel private code, played protected class menu/SAM and exact native attendee creation. The pass case separately verifies entitlement and binds the same native case in its request. Four modes per ordinary/pass cohort cover accepted retention, wrong-patient grant, stored memo with lost acknowledgement and native clinical response loss. Known clinical success survives memo denial or uncertainty; clinical uncertainty supplies no memo purpose. A pass proves no payment, and shared class notes remain untouched. Pending prior patient retention cannot follow a new workflow.

Earlier class-test failures remain preserved: the first pass driver missed the actual capacity instruction; its diagnostic showed60s waiting with writes0. The next driver retained pre-Yes state for the ordinary path and interrupted pass SAM with presence questions. The corrected test reads fresh post-Yes state and follows the existing signed pass runner using quiet20ms media for real elapsed quota time, then a fresh affirmative. No production behavior, quota, lease/proof/action/memo deadline or expected outcome changed. Both earlier PR580 cloud failures and their controlled RED witnesses likewise remain separately recorded, not success evidence.

Each of17 source files runs once with two isolated workers in a1GiB/CPU200% scope. Each SQL cohort uses its original unfiltered normal entrypoint and independent disposable database/container/private paths. Node and external PostgreSQL each retain512MiB/CPU100%/Swap0 limits and are cleaned after natural terminal. Native180 and actual verification budgets, permanent purposes and real quota waits remain. Every-column and complete unfiltered raw/COPY/JSON backup scans retain unrelated aliases, staged scans and opaque effects. Live growth plus reserve governs compute admission.

Current proof work: source=1792624918250, adultSQL=1792625192686, guardianSQL=1792625197885, tasksSQL=1792625204570, outgoingSQL=1792625217542, ordinaryClassSQL=1792625394947, passClassSQL=1792625212055, cancellationSQL=1792625122201, build=1792624925255. The fresh strict/build produced722 outputs; only the four named test helpers differ from c390. Actual normal580 integration preserves all qualified source/artifact bytes before these final documentation updates. Current facts/scenario/naming/source/artifact/cleanup guards and independent Standards/Spec review precede publication. This adds no sender-kill/restore or real clinic/source acceptance. Actual-main checks remain separately tracked; the full thirteen-gap scope is open.

The sixteen signed cancellation cases cover ordinary attendance and the already approved releaseOne, unchanged and consumeOne pass profiles, each accepted, wrong-patient grant, stored-but-lost memo acknowledgement and native response loss. They use the actual classifier date mapper, private keypad proof, played exact-target cancellation SAM, one native attendee PATCH, subsequent inspection and original reviewed cancellation marker. Known clinical cancellation survives independent memo denial or uncertainty; native uncertainty supplies neither memo facts nor a memo purpose. A pass counter effect proves no payment, fee waiver or refund. Actual public intent inputs join the model/transcript/progress and every-column/full-unfiltered-backup privacy checks.

The initial cancellation driver failed16/16 before dispatch because its hand-built midnight range bypassed the existing public date mapper; the selected diagnostic observed a failed appointment read with claims7, writes0 and recalls0. The next normal run passed ordinary4 but all12 pass cases caught a booking-only not-reserved assertion copied into cancellation. The corrected assertion checks actual cancellation wording: attendance has not been cancelled. It retains the actual60s wait, quiet20ms media and fresh affirmative. Source96 controls and all722 output bytes remain exact while the nonemitted SQL driver is corrected; current whole strict and normal16 signed SQL qualify that driver. These standalone results are separate from this fresh199/73 graph. No application, quota, deadline, expected clinical outcome or privacy assertion was relaxed.

## Signed class movement and required financial creation follow-up, 22 October 2026

The signed class memo follow-up locally qualifies 123 distinct source controls across 10 files, whole strict TypeScript/722 serving outputs and27 distinct actual emitted signed PostgreSQL/privacy cases: ordinary two-leg movement 9, ordinary creation 9 and approved-pass creation 9. The creation cohorts contain 10 required-financial cases and 8 preserved notRequired cases. Private segmented financial readback, played carrier marks and explicit keypad consent precede a separate clinical Yes; consent establishes neither charge, payment, waiver nor refund. Original movement reports preserve moved/restored/needsReview and exact leg observations across lost acknowledgements; no atomic move or blind replay is inferred. Both reviewed components now share this freshly tested graph; historical passes are not summed. Only class-move-call-flow and the finite verification-code-canary test helpers differ from the parent 722 outputs; every production and other 720 output byte is exact. Parent PR #581 normally merged at 7916d8d4bfed after all 8 own exact-head cloud jobs and full raw-log archive; its actual-main CI remains independently owned. This follow-up still requires final review, own publication/cloud and normal merge. Broader representative/pass/staged/catalogue/financial-movement combinations, new sender kill/restore and actual clinic/source/retention/provider acceptance remain separate. The owner selected clinic staff review first on 22 October for private/unclear outbound contact coverage, with future calls blocked while unresolved; that workflow is separate ongoing engineering. No recording, no-stop inference, deployment or activation. See [current class follow-up evidence](COMMUNICATION_MEMOS.md#signed-class-movement-and-required-financial-creation-follow-up-22-october-2026).

The independently qualified components are ordinary movement c4e35c4 and required financial creation cb789b4, each with 0/0 preliminary Standards/Spec findings. Their clean combined fd2e1b2 candidate is now tested directly: source 123 (1792630289484), whole strict/722 build (1792630298126), ordinary 9 SQL (1792630569442), approved-pass 9 SQL (1792630576616) and movement 9 SQL (1792630596172). All selected cases have zero failures, skips or cancellations; all 27 SQL names are distinct. The pass cohort retains real 60s budget waiting, normal carrier frames and fresh confirmation. No existing timeout, quota, proof, silence, policy or action expectation is relaxed.

Movement qualifies signed inbound self ordinary nonstaged two-leg reporting only: moved, wrongSubjectGrant, withdrawn, lostStored, lostOriginal, lostReplacement, restored, lostCompensation and lostReview. The confidential patient memo keeps the original reviewed attendance action and actual report, including needsReview with uncertain/notSent leg facts. Wrong-subject/withdrawn memo authority or uncertain retention cannot erase known clinical progress. Missing owned workflow evidence supplies no memo/purpose. Pass/staged/representative/required-financial movement variants remain unqualified by these 9 cases.

Required-financial creation uses the existing separate financial and memo PostgreSQL effect owners and the same physical native 180 budget. Ten required ordinary/pass cases cover accepted, wrongSubjectGrant, lostStored, clinicalResponseLost and financialResponseLost; the eight existing notRequired cases are preserved on the same current graph. Financial native observation response loss cannot erase acknowledged class creation or independently permitted memo retention. Lost native clinical ACK leaves prospective financial intent only: no memo, financial booking observation, collection permission or replay. Opaque native financial action UUIDs are checked as permitted one-use exclusions; private financial payloads are not permitted local persistence.

Each cohort migrates its own disposable PostgreSQL and retains legitimate unrelated phone-index/staged-scan/effect state. Every SQL column and complete unfiltered raw/COPY/JSON backups are scanned for private verification/consent/financial terms, native identities and memo/private-key material. Per-case canary windows start before verification and close after all owners. Sources, dependencies and 722 artifact hashes remain pinned, and owned database/container/slice cleanup passed. All scopes retain Swap0 and no OOM/high/max events. The earlier component and failed diagnostic evidence remains historical. This qualification supplies no new sender SIGKILL/full-restore proof, real clinic grant or retention acceptance. Existing appointment/treatment/shared-class notes remain outside this selected memo operation.

## Class follow-up and owning restore correction, 22 October 2026

The signed class memo follow-up retains its separately qualified 123 source controls, 722 serving outputs and 27 signed SQL/privacy cases for ordinary movement and required-financial ordinary/pass creation. Parent PR #581 normally merged after its eight own-head cloud jobs, but actual main 7916d8d later failed one PostgreSQL restore witness: 6,601 passed, one failed and one skipped; its other three jobs passed. Complete raw logs are archived. The test compared a frozen full backup with later complete live effect rows while another legitimate test writer advanced them. An unchanged-source controlled writer reproduced that exact failure. The narrow correction exports one repeatable-read snapshot for both the complete expected effect/hold tables and the unfiltered backup, with real independent opaque writes before and after that snapshot. Whole strict TypeScript and five normal parallel callback/process/restore cases pass; every production and all 722 serving bytes remain unchanged. A separate controlled GREEN witness is not added to normal counts. Earlier class 123/27 evidence remains separately preserved through unchanged source dependencies and serving bytes; this is no freshly rerun 32-case combined claim. Current maintained facts, exact-head review, same-PR publication, new own-head cloud and ordinary corrected merge remain gates. Historical main failure stays failed. No assertion, quota, deadline, concurrency, native permission or privacy dump is weakened. Real clinic/provider/source/retention/restore acceptance and activation remain open. Owner-selected clinic staff review for unclear outbound coverage is separate ongoing work, with future calls blocked; no recording or no-stop inference. See [the owning restore correction](OUTBOUND_STATUS_DELIVERY.md#consistent-full-restore-snapshot-22-october-2026).

The restore witness and its shared privacy helper are the only additional test-source changes after reviewed2047802. The class source controls and three SQL entrypoints retain their exact dependencies and all 722 serving outputs. The current five callback/process/restore cases qualify the owning regression; they are not added to old class counts to imply a freshly run combined32. Existing individual, class, guardian, financial, clinical and contact permissions remain unchanged. The new actual-main failure and both controlled witnesses remain separately auditable.
