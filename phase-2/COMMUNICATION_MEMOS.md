# Approved communication-memo engineering

The owner selected separate confidential Cliniko communication memos for
verified administrative booking, rescheduling and cancellation facts. Existing
appointment and treatment notes remain untouched. This branch implements the
native-record primitive, optional individual-booking receipt capture and optional
observed cancellation/rescheduling capture through the approved session/voice
compositions. Per-patient class outcomes and complete recovery remain unfinished. No default configuration,
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

## Work still required

Extend actual source capture to approved per-patient class facts without writing
shared-class notes or promoting partial movement into complete success. Qualify distinct verified subjects, representative,
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
