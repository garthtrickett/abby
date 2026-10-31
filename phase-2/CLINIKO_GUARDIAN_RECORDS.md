# Clinic-approved guardian records

Abby has a local, optional route for a caller who is not a Cliniko patient to
verify a clinic-approved contact identity and request an administrative action
for a separately verified patient. The owner selected this approach on
27 October 2026. This route does not determine legal guardianship or confer
clinical authority. Production provisioning and clinic acceptance remain open.

## Three independent approvals

| Approval | What it establishes | What it cannot establish |
| --- | --- | --- |
| Guardian process policy | A current clinic administrator approves this identity workflow for an exact clinic, business, physical account, policy version, time zone and listed operations. | Any caller's identity or authority over a patient. |
| Guardian identity record | The clinic independently approves an exact active Cliniko Standard contact, record version and revision. Its registered non-fax phone must match the incoming number and it must have a current registered email. | Possession of that email, patient identity or patient/action authority. |
| Patient/action authority record | The clinic independently approves the exact guardian identity record/version/revision, contact, patient, operation, authority kind and permitted purposes. | A patient verification code, workflow consent or permission for another operation. |

Each private record also carries the existing clinic-approval scope, current
administrator, revision, enabled/approved state and effective period. Missing,
ambiguous, changed, expired or withdrawn records refuse the workflow. Contact
notes, family labels, a shared channel and a caller's account of a relationship
cannot substitute for approval.

The authority record distinguishes `guardian`/`minor` from
`adultRepresentative`/`adult`. The latter requires its own explicit process
approval; it is not enabled by the default guardian fixture. Native patient age
is checked in the approved clinic time zone, with the existing March 1 leap-day
rule. The implementation does not infer the legal sufficiency of an approval.

## Private call sequence

1. The trusted host prepares one or both actual identity methods: an existing
   clinic patient, or a clinic-approved non-patient contact. Preparation sends
   no codes and reads no caller/contact identity. Both configured process
   policies must be current; failed setup does not silently choose a fallback.
2. If both methods are configured, played private keypad instructions ask the
   caller to choose a method before either code is issued. The choice is held
   for this owner. An unsuccessful chosen method cannot switch to the other.
3. The guardian route reads its independent identity approval and exact native
   contact, then verifies possession through a separate registered-email code.
   This produces a call-bound `VerifiedGuardian`, never a `VerifiedPatient`.
4. The caller supplies the patient's name and date of birth through the private
   input path. Current independent patient/action authority must pass before
   Abby reads protected native patient identity. The exact native patient and
   age must match that approved authority.
5. A separate code sent to the selected patient's registered email produces the
   ordinary operation-bound patient proof. Even a shared guardian/patient email
   uses separate transactions. The guardian proof cannot replace this step.
6. The existing enquiry, booking, cancellation or rescheduling workflow still
   requires its own current policies, permissions, played notices/consent and
   native request budget. Financial, class, outbound and subsequent task
   permissions are not inherited from the guardian approval.

Method choice and codes open no ASR stream. Private identity fields and their
readback remain in the existing private media path rather than ordinary caller
turns or model context. Codes, contact/patient identifiers, private fields and
proof references are not added to a standalone database, queue or log.

## Host interfaces and boundaries

`RepresentativeInputConfig` supports the existing native-patient configuration,
a guardian-only configuration, or both. All retain the independent
`representativeCallerApprovalPath`. The optional `guardian` configuration has:

- `approvalPath`: the separately approved guardian process policy;
- `identities`: a trusted `ClinicGuardianIdentityRecords` source;
- `authorities`: a trusted `ClinicGuardianPatientAuthorityRecords` source.

The record sources return one complete clinic-approved match or no result for
absent/ambiguous lookup. They are trusted host ports, not caller/model tools.
The implementation captures their receivers and methods before asynchronous
setup. Sources and administrator membership must declare their real bounded
native cost where applicable; unknown callback work stays unknown. Account
bindings use the same physical-account budget and credential fingerprint as
the native readers. The existing 180-request budget is unchanged.

`ClinikoGuardianContactReader` reads only the exact approved Standard contact.
It validates account/shard/self-link, active state and registered channel, and
rechecks the complete identity record and administrator membership after native
I/O. `GuardianPatientAuthority` independently checks subject/action records and
membership. Protected reads freshly revalidate the guardian's native channel;
an issued snapshot only permits a non-disclosing approval lookup and cannot
renew patient authority. Changed process, account, channel, record or membership
defeats a late result. Close, expiry and abort dispose pending work and suppress
late code delivery.

`ClinikoGuardianSelection` and the existing native patient selector are the two
concrete trusted workflow owners. Structural lookalikes cannot supply a
selection. Their shared selected-patient verifier preserves separate current
registered-channel and workflow permission checks. Native-patient-only callers
retain their existing method and prompts.

The optional `ownerFileGuardianRecords` adapter supplies these ports from
restricted clinic-owned files. The owner selected restricted clinic-owned
approval files as the first adapter. Actual clinic records and production
acceptance remain separate. The original qualification below
uses injected synthetic clinic sources; the file-source qualification is separate. A Standard contact is native Cliniko identity evidence; it is
not a native guardian-authority record. Abby does not create fake patient
records, infer approvals from contact notes or automatically provision private
approval records.

## Local qualification, 31 October 2026

The local component has passed 203 source controls across 22
files, including preserved patient/native representative, private input,
verification, renewal and canary controls. Whole strict TypeScript and the
actual serving graph/build passed. All 746 inherited serving outputs remain
present: 738 are unchanged, eight change for the shared/private composition and
eleven new outputs bring the graph to 757. A later SQL test-driver-only
correction also passed whole strict TypeScript; it did not rebuild or change
the emitted production/helper bytes.

The eight shared registered-email challenge controls live under `test/contract`,
so both normal text and PostgreSQL CI selectors include them. Their executable
bytes are unchanged from the original source cohort.

Three unchanged signed native-patient guardian/shared-email cases also passed
on the same outputs: accepted two-child booking, missing second-child authority
and changed recipient. They preserve separate caller/patient code transactions,
immutable first-task receipts, the existing native 180 budget, all-column
privacy and complete raw backups. These are separate preservation evidence;
they do not add three new guardian-record scenarios or a restore qualification.

The first actual emitted signed HTTP/media/PostgreSQL trial passed six of seven
cases, including all four administrative operations, missing patient authority
and withdrawal before consent. Its missing-identity case failed because the
test helper treated the intended final code refusal as an unexpected input
failure. That failed run and its evidence remain retained. The corrected
successor passed all seven cases with zero skips. It observed the actual final
refusal and closure, refused fallback/discovery/delivery, and passed all-column
privacy and unfiltered logical backup/restore with an unrelated row retained.
Both runs' owned databases, containers and anonymous volumes were removed;
container and volume absence was independently verified. The corrected Node
scope peaked at 270,274,560 bytes and its separate PostgreSQL scope at
143,437,824 bytes, with no OOM events.

Private evidence is retained under
`~/.local/state/abby-outbound-stop-speech/guardian-records/`: serving artifact
map/result/terminal, current-source result/terminal, SQL v1 failure and cleanup,
SQL-refusal strict result/terminal and SQL v2 inputs/result/terminal.
Counts describe these exact cohorts and are not added to overlapping historical
component counts. Fixed-head review, own-head CI, normal delivery and independent
resulting-main qualification remain separate engineering gates.

## Clinic acceptance still required

Before activation, the clinic must approve the actual identity/authority record
store, provisioning and withdrawal owners, administrator membership source,
access, retention and recovery. It must supply current contact/channel and
exact subject/action approvals, including any separately permitted adult
representation. Registered-mail delivery, staff handoff and supervised clinic
workflows require their own observations. The local signed media route and
synthetic sources do not prove carrier delivery, acoustic quality or a real
clinic's authority decisions. There is no default activation, live call,
provider write or deployment in this qualification.

The original [execution order](EXECUTION_ORDER.md),
[thirteen-gap plan](THIRTEEN_GAP_IMPLEMENTATION.md),
[booking plan](PROVIDER_ACKNOWLEDGED_BOOKING_PLAN.md) and
[reuse audit](KAREN_TO_ABBY_REUSE_AUDIT.md) retain their full scope and remaining
acceptance gates.


## Original CI and synthetic-code refinement

The original PR #617 push had one existing two-patient memo privacy-canary
failure; its independent PR run passed that case and the complete database
suite on the same head. The failed verdict remains and its exact matching
value is unavailable. A deterministic preexisting-public-hash collision is
separately demonstrated. The direct SQL fixture now excludes existing public
numeric substrings before the next synthetic challenge, with a fresh owned
snapshot/window and exact restoration per case. It refuses any snapshot that
already contains an issued code; no privacy scan is filtered or exempted.

Thirteen source controls, whole strict/757 serving and all six affected signed
SQL cases pass locally. Only the shared test helper's emitted bytes change;
756 other outputs stay exact. Production modules and guardian semantics stay
unchanged. The wrapper's incorrect expected test count is independently
reconciled against the 13-test source syntax and completed TAP, preserving its
failed verdict. See [failure, correction and limits](EXECUTION_PROGRESS.md#guardian-ci-public-code-canary-refinement-31-october-2026).
Current exact-head review, own CI, normal delivery and clinic/provider
acceptance remain separate gates.


## Optional clinic-owned file sources, 31 October 2026

A trusted host can construct `ownerFileGuardianRecords` and pass its `identities`
and `authorities` into the existing `guardian` configuration. The host supplies
fixed absolute `identityPath` and `authorityPath`, clinic/location, policy,
Cliniko business/credential fingerprint and the actual shared native budget.
Caller turns and model tools cannot select a path or construct this configuration.
The adapter provisions no records, writes no file and enables no runtime default.

Each private JSON file has exactly `schemaVersion` (1), `kind`, `scope`,
`policyVersion`, `businessId`, `credentialFingerprint` and `entries`. The identity
kind is `guardianIdentities`; each entry has an E.164 `normalizedPhone` and one
complete `ClinicGuardianIdentityRecord` under `record`. The authority kind is
`guardianAuthorities`; each entry has the complete private patient `identity`
(first name, last name and date of birth) and one complete
`ClinicGuardianPatientAuthorityRecord` under `record`. An empty collection denies.

The source rereads regular files owned by the service's OS user, with no group or
other permissions; final-file symlinks are refused. Each file is limited to
65,536 bytes and 64 entries. A malformed collection, wrong scope/account/policy,
missing or ambiguous index and aborted lookup produce generic failure. Index
matching uses complete NFKC/case-normalized names and exact birth date, matching
the existing native selection. Exact current guardian contact, record/version/
revision and requested action identify the authority candidate. Disabled, expired
or partial-purpose duplicates are not filtered into apparent uniqueness, and
multiple grants cannot be combined. Returned records are independent copies;
there is no cached approval snapshot.

An index is not authority. The existing concrete owners still validate the one
record's approval, current clinic-admin membership, expiry, policy, native
contact/channel, subject identity/age and per-action permissions. Guardian and
patient codes remain separate. Editing, deleting or withdrawing a record is
observed at the next fresh boundary. Aborted lookups suppress late results. The
file callbacks declare zero native requests only for the exact configured
account/budget; contact/patient I/O and all other costs still consume native180.

The current local cohort passed 84 source controls across seven files (13 new
file-source controls and 71 inherited guardian controls). It exercises native
proof composition for all four existing administrative operations. Whole strict
TypeScript and the actual serving graph/emission passed: all 758 inherited
outputs remain, 755 are identical, three change for the shared identity comparator
and registered SQL fixture, and two additions bring the graph to 760.

Four actual emitted signed media/PostgreSQL booking cases also passed with zero
skips: accepted, missing identity, missing authority and withdrawal before
consent. They use the real file ports, native180 and separate guardian/patient
verification, preserve every-column scans and the unchanged unfiltered logical
backup/restore/cleanup assertions, retain an unrelated row, and additionally
check that private file paths do not enter public state or SQL. The Node scope
peaked at 265,023,488 bytes and PostgreSQL at 168,464,384 bytes, with no OOM events.
Owned container, anonymous volume and socket-directory absence were independently
verified. The inherited signed four-operation cohort is separate evidence; the
new file-source signed cohort covers booking.

Evidence is private under `~/.local/state/abby-outbound-stop-speech/guardian-file-records/`.
The initial 83-control/strict cohort is retained and is not added to the final
84-control total. Review, publication and resulting-main CI remain engineering
gates. The clinic must still approve and provision its actual record files,
provisioning/withdrawal owners, access, retention and recovery; this local trial
does not back up or approve clinic file storage. The original clinic/carrier/staff
acceptance requirements above remain. No real guardian record, native write,
call, deployment or runtime activation follows from these synthetic results.
