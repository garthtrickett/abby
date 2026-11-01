# Proposed operator acceptance

The [clinic setup and rehearsal command](CLINIC_SETUP_AND_REHEARSAL.md) supplies a twelve-scenario local worksheet pinned to the current committed source and six owner configuration areas. It records self-reported staff observations only; missing configuration, failed/unrun scenarios and source drift remain visible. It neither replaces the observations below nor supplies activation authority.

Status: proposal only, updated 1 November 2026. Full current-candidate acceptance
has not been executed. Earlier scoped demo rehearsals are recorded below.
This supplies the manual-test proposal required by [execution stage11](EXECUTION_ORDER.md).
It does not activate a clinic or authorize provider mutations, real mail,
payments, deployment or the deferred carrier work.

Use the existing [booking contract](../docs/adr/0002-provider-acknowledged-booking.md)
and [staff observation contract](../docs/adr/0003-class-movement-staff-resolution.md).
The three plans retain their requirements; this is an operator evidence route,
not a substitute for engineering, independent review or authoritative CI.

## Candidate and ownership

Before a separately authorized rehearsal, record the exact source/build,
clinic/account/location, synthetic subject owner, current permission/policy
versions, approved recipient and the staff member responsible for cleanup and
unresolved review. Use owned patient-free fixtures and a dedicated approved
environment. Keep native identities and any protected observations in the
clinic-approved private evidence destination; the repository receives only
scenario labels, source hashes, fixed outcomes and pass/fail reasons.

### Selected rehearsal backup role, 23 October 2026

The user remains the primary owner and delegated the backup role choice to the
implementation agent. The selected backup is the clinic practice manager. Where
that role does not exist, the clinic's senior receptionist can fulfil it when a
real staff member is nominated during setup. This resolves the role choice only.
Before a clinic-staff rehearsal, identify that person and verified alert destination
privately, bind a distinct clinic-approved backup actor in the same scope, and
observe independent sign-in and explicit acknowledgment after primary
non-acknowledgment. A saved inbox item or notification receipt does not prove
human responsibility. No account grant, paging or alert send has occurred from
recording this choice. See the [operator response contract](../deploy/voice/OPERATOR_RESPONSE.md).

### Owner-designated agent demo backup, 25 October 2026

The owner subsequently directed another agent to perform the demo backup role
through browser drive or the API. That owner-designated demo role is now
exercised. Real clinic staffing, external delivery and human acceptance remain
separate.

The agent signed distinct synthetic primary and backup accounts into the
actual TLS operator application through captured local sign-in messages. The
primary never acknowledged. After 60.227 actual monotonic seconds, the backup
explicitly acknowledged through the browser. A deliberately lost committed
response, acknowledgment retry, receiver retry and application reconstruction
preserved version 1 and the original two-minute responsibility deadline.
Early backup, late primary, spoofed actor, foreign origin, removed membership
and withdrawn approving-role actions were refused. The parent independently
checked the raw steps, durable versions, screenshots, source/artifact hashes
and cleanup. See [the scoped observation](../deploy/voice/OPERATOR_RESPONSE.md#agent-operated-demo-backup-observation-25-october-2026).

The sign-in store was an in-memory fixture retained across application
reconstruction; this run did not test full process/session-database recovery.
No Cliniko or Stripe request, external message, patient action or deployment
occurred. It does not execute the other clinic acceptance rows below. The
cash/bank-payment rehearsal remains pending by the owner's explicit choice
because no synthetic invoice with a recorded payment is available.

### Existing authorized Cliniko demo account

An existing real Cliniko demo account is available as the rehearsal target; a
new clinic does not need to be identified. Its owner-only configuration remains
at `/home/gust/code/abby/.env`. On23October, the named API-key/contact settings
were present and nonempty with file mode0600. A separate read-only metadata
check returned HTTP200 for businesses, practitioners and appointment types.
It read no patient endpoints and made no writes. A later guarded eight-GET
preflight validated the existing demo catalogue and found no active patient or
recall-type fixture belonging to the named lifecycle rehearsal; its two patient
queries used that fixture's exact email/name filters. The eligible service is
30minutes and the account timezone remains Asia/Jakarta. No setting was changed.
Archived history, other fixture families and acceptance of newer workflows
remain unverified.

The [C-LIVE-59 lifecycle](../phase-0/CLINIKO_EVIDENCE.md#c-live-59--complete-admitted-demo-lifecycle-with-independent-readbacks-and-cleanup)
passed on5October: real provider intake, two bookings, one reschedule, one
cancellation and four review recalls, followed by independently verified cleanup
and restoration of the original online-booking flag. Its caller admission,
permissions, mailbox and playback were synthetic. The separately authorized
[C-LIVE-58 UI rehearsal](../phase-0/CLINIKO_EVIDENCE.md#c-live-58--authorized-cliniko-reportnotes-ui-rehearsal-and-verified-cleanup)
observed the dedicated review and persisted acknowledgment, then verified cleanup;
it was agent-operated, not human staff acceptance.

Use these actual historical results and the existing demo target when planning
the current observations. First verify current account access, fixture state and
the exact source/configuration required by the selected exercise. The older
rehearsals do not qualify later class/pass, Stripe, outbound, communication-memo
or acoustic behavior on the current candidate. Their existing authority and
scope remain explicit in the [lifecycle runbook](CLINIKO_LIVE_LIFECYCLE.md) and
[staff-review runbook](CLINIKO_REVIEW_REHEARSAL.md).

### Current engineering boundary, 23 October 2026

PR589 normally merged as `78158d9`; its eight own-head jobs, actual parent-main
checks and all four resulting main checks passed with raw results independently
verified. This is selected engineering evidence, not execution of the observations
below. The full thirteen-gap scope and clinic/provider/source/retention/restore,
sender/mailbox, acoustic and activation requirements remain open.

The selected outbound path is Twilio with Abby's runtime and clinic workflows,
with versioned runtime/transcription seams for a separately qualified adapter.
Positive authenticated opt-outs can retain restrictive Cliniko DNC under the
approved policy. Private or unclear whole-call evidence targets clinic staff
review while future calls remain blocked. Incoming original-target context and
separate confidential communication memos have scoped engineering evidence;
neither a memo nor a closed staff task clears contact or supplies clinical
authority. Read their [current scope](INCOMING_MISSED_CALL_CONTEXT.md) and the
[staff-review contract](OUTBOUND_STAFF_REVIEW.md) before selecting a rehearsal.

PR590's corrected listener shutdown normally merged as `327d0c3`; all eight
own-head and four independently resulting-main checks and raw results passed.
The optional Deepgram experiment subsequently passed its eight own-head jobs
and raw counts before normal merge as `9c49a6f`. All four independently resulting
main checks and raw results have also passed, with all sixteen parent/own/main
logs and expected counts verified. The combined local graph retains 63 source controls, whole
strict TypeScript and 741 default artifacts identical to parent `327d0c3`.

The three streaming noise profiles and the private whole-utterance Nova-3
comparison all fail their acoustic gates. Private Whisper returns six matches
and twelve unavailable results, so successful-only metrics cannot approve that
profile. Its separate 23-control protocol/scoped-types evidence does not qualify
host or serving admission. No clean/safety follow-on or runtime selection follows
these failures. Current OpenAI noisy/safety failures and all representative,
public-route and carrier gates remain. See [the speech gate](../eval/SPEECH_QUALITY_GATE.md)
and [optional experiment](../phase-1/DEEPGRAM_TRANSCRIPTION.md).

### Historical engineering checkpoints

The 17 October engineering checkpoint is combined candidate `ff795012`
(draft485), with the clinical fixes and inactive Stripe protocol/discovery/stream
adapters from drafts475/476/482. The corrected complete PostgreSQL regression
`work1792198488746` finished at01:47:50UTC with3,218passes, one cancelled-email
E2E-380 private-choice timeout and one existing skip across3,220tests. Ordered
follow-up did not run. The earlier7ca full had3,171passes/seven failures/one skip;
its history is preserved in the progress ledger. Focused corrections do not replace a complete result, and
exact-head cloud checks have not executed because of account billing limits.
The later19October engineering checkpoint is through539d5f901e: its full regression is currently running, not green. Last completed through53629c373d full passed4619/0/1 plus6ordered, while current test-only655dce1 separately qualifies the selected class/pass/resend native settlement profile. These are local source-specific results, not executed operator acceptance.
No single candidate currently qualifies all thirteen gaps. Pin the actual
then-current source/build and its completed evidence before any separately
authorized rehearsal; none of these hashes constitutes activation approval.

### Signed-waiver demo engineering observation, 25 October 2026

The existing demo account completed a separate current-runtime booking and
signed-waiver exercise: exact original receipt and current read, independent
grant refusal, no duplicate write, full SQL privacy and owned cleanup passed.
The provider run used 103 native requests, one booking/draft/seal, six archives
and one Stripe test-account GET, with no money or message. Its independent audit
passed and all waits are reaped. The prior uncertain family's records/key and
failed verdict remain retained; the successful new family is consumed.

Caller verification, playback, issuer/admin approval and clinic grants were
synthetic. This supplies engineering evidence for the selected gap11b waiver
path, not actual staff approval, complete financial decisions, cash/bank invoice
mapping or any other operator row. Keep the observations below open until their
actual scoped evidence exists. See [the exact candidate, hashes and limits](STRIPE_PROVIDER_REHEARSAL.md#delivered-waiver-sdk-and-native-demo-observation-25-october-2026).

## Non-patient guardian rehearsal

The owner selected restricted clinic-owned approval files for the optional
[guardian record route](CLINIKO_GUARDIAN_RECORDS.md#optional-clinic-owned-file-sources-31-october-2026).
This permits a separately approved guardian who is a Cliniko contact without
requiring that guardian to have a patient record. It does not provision records
or approve a real guardian, patient, channel or operation. The existing native-
patient guardian route remains a separate selection.

Before a separately authorized clinic rehearsal:

1. Record which guardian route is selected. For the file route, the clinic must
   approve the private identity and authority files, their provisioning and
   withdrawal owner, access, retention and recovery. Bind the actual clinic,
   location, account and policy, exact Cliniko contact and patient IDs and each
   permitted operation. Use the file contract above; keep private contents and
   paths out of this repository and public evidence.
2. Use an approved test guardian with no Cliniko patient record. Observe the
   current native contact and registered channel independently from the file
   approval, then complete separate guardian and patient verification. A shared
   channel does not combine their proof. Current native patient identity and
   per-action permissions must still pass before protected work.
3. Exercise the selected individual appointment enquiry, booking, cancellation
   or rescheduling journey
   against its exact approved patient and target, with the applicable fresh
   selection and played consent. An enquiry must not write. Each mutation must
   retain its exact outcome and must not derive authority from the caller's
   phone number, spoken relationship or earlier patient's proof.
4. With the clinic's approval, exercise missing, ambiguous and withdrawn records,
   including withdrawal after verification but before final consent. Changed
   native contact/channel or patient/action permission must also refuse the
   affected access or write. A refused file route must not silently fall back to
   another identity method. Record unsupported follow-on tasks as open; do not
   infer a second patient's authority from the first task or alter its receipt.

Retain the exact source/build and configuration versions, fixed observations,
remaining obligations and cleanup result in the approved private evidence
location. Keep an unrun or failed operation open. These are proposed clinic
observations; earlier synthetic passes and the storage choice do not execute
this rehearsal or establish human, carrier or acoustic acceptance. Class,
financial, memo and general representative authority retain their separate
contracts.

## Operator observations

Run only the rows supported by that exact candidate and separately authorized
fixture environment. Missing authority or implementation means the row stays
open. Observe each effect at its actual native target and record ambiguity
without replaying the original action.

| Gap | Rehearsal | Required observation |
| --- | --- | --- |
| 1 | Booking, enquiry, cancellation, rescheduling and registration followed by separate booking | Actual admitted host composition reaches the intended workflow. Protected enquiry has no mutation; registration success does not itself book. A confirmation describes the exact current action. |
| 2 | Wrong/expired code, revoked permission, changed subject and related-person task | Possession and current operation/subject permission are independent. Old proof cannot authorize another patient or operation. Successful renewal alone cannot replay a confirmation. |
| 3 | Lost provider response and interrupted sender, then clinic staff investigation | The original call remains uncertain. The approved native review is independently discoverable, staff ownership is real, and a saved request/alert is never described as human receipt or resolution. No automatic replay. |
| 4 | Repeated noisy/correction audio and public transport | Retain the unchanged source-matched speech gates and failure evidence. A usable route, provider latency, a model transcript or synthetic transport success does not satisfy the failing acoustic gate. Carrier work remains deferred. |
| 5 | Approved location/service, duration and initial/follow-up choice; withdraw approval before send | Exact current catalogue selection and named destination survive through confirmation. Missing/withdrawn approval denies. An incomplete refresh cannot silently remove or broaden clinic approvals. |
| 6 | Longer/approved offline calendar search; incomplete page and late conflict | A complete approved source supports the actual chosen interval. Incomplete reads deny a complete availability answer. Native dated recurrence is observed, never extrapolated. |
| 7 | Explicit different practitioner at retained and changed time | Independent destination approval, exact original and fresh destination are shown. The original remains protected until the operation-specific reschedule contract succeeds. |
| 8 | Private correction and resend, with an unplayed choice, interrupted readback and revoked recipient permission | Private values stay out of model/public output. An unplayed choice cannot gain authority later. Resend needs its own exact appointment/recipient and played approval; accepted mail is distinct from mailbox receipt. |
| 9 | Two independently verified subjects and mixed read/write tasks | Each action retains its own subject, permission, confirmation and immutable result. Changing task cannot borrow the prior patient's private proof or turn an enquiry into a write. For a guardian without a patient record, follow the [non-patient guardian rehearsal](#non-patient-guardian-rehearsal), including current contact verification and independently approved file records. |
| 10a | Ordinary and approved-pass class creation; inspect native outcome after the caller result | The validated exact provider acknowledgement establishes creation. Manual readback records outcome without becoming a runtime success veto. Capacity/pass races remain explicit; creation proves neither payment nor an entire move. |
| 10b | Ordinary/pass movement, quota wait, renewal and corrected date/service | Each current phase is separately presented, actually played and confirmed. Wait/renewal cannot revive an old selection or approval. Inspect original, replacement and any case effects jointly; replacement creation alone is partial progress. |
| 10c | Lost movement result followed by authenticated cold staff observation | Independently establish sender quiescence and current staff permission. Unknown/contradictory state stays for review; a recalled review is not completion. Observation grants no new mutation or caller success. A restoration observation requires the exact cancelled/unlinked replacement and unchanged original case use where applicable. |
| 11a | Exactly quoted individual/ordinary-class/pass deposit; lost payable response and cold review | Current clinic fee/source/recipient/mapping, producer/restore and complete financial permission must be independently provisioned. Observe one payable for the exact action/account/mode/amount/currency. Booking acknowledgement survives financial failure. Unknown creation remains consumed and readonly/reviewed, with no second charge. |
| 11b | Cliniko recorded payment; current full/partial signed waiver; absent/expired/recalled/foreign evidence | Native recorded-paid state and an independently approved current positive waiver prevent original full-amount collection/link or clinical expiry. Partial payment/waiver cannot silently change the immutable amount. An open invoice or missing waiver is not proof nothing was paid or waived; unavailable complete clinic financial decisions stop automation. Authoring/current supersession and actual approval evidence remain required. |
| 11c | Payment before/after the permanent clinical or resend claim | Payment before the effect prevents the claim; later financial refusal prevents dispatch while keeping consumed exclusions. Independently observe exact appointment/own attendee/case consequences; closed Checkout is not cancelled clinical work. Known cancellation and money remain distinct. No automatic refund, restore, coverage or replay follows. |
| 11d | Explicit link/receipt resend, sender failure and reordered/duplicate payment events | Preserve exact original provider/recipient/current sender and independent resend approval. An approved resend cannot create a replacement payable. Known received Stripe money remains received; a current native paid invoice cannot erase a valid Stripe receipt. SMTP acceptance differs from mailbox delivery. |
| 11e | Current native quota, process interruption and backup/restore recovery | Price the actual complete clinic authority/native read profile under the physical180 budget; six/eight synthetic authority totals are not clinic defaults. Independent complete native history, producer/quiescence and restore grants prevent replay after local row loss. Optional serving provision stays disabled until separately accepted. |
| 12a | General follow-up, changed/expired consent, each independently withdrawn grant, cancellation/quiet boundary and competing launch | Independently provision the actual native source/contact/campaign/producer/restore/provider grants. One optional adapter launch follows exact possible-attempt retention and current final checks. Acceptance is distinct from delivery, terminal or clinical success. No unchanged automatic retry. |
| 12b | Interrupted or ambiguous launch; backup/remap while capacity remains held | Inspect native possible history and permanent exclusions jointly. Timeout, dead process or a lease never proves a remote call ended. Preserve held capacity until a selected authenticated provider reader proves every matching call terminal under current native/mapping/provider/release grants. The conditional owner exists; a real provider source still needs independent qualification. Legacy/untagged/unknown calls remain held. |
| 12c | Opt-out, changed sick-day target and protected callback | Finite exact-appointment scheduling, authenticated positive opt-out retention, unclear-contact staff review and protected original-target callback paths have scoped synthetic engineering evidence. Real clinic/provider acceptance of their composition remains unexecuted. Authenticated provider opt-outs may automatically record dedicated Cliniko DNC under approved clinic policy. Qualify shared-number blocking, uncertain acknowledgement and independently approved reconsent. Fresh native target and separate patient/operation authority are required; a shared number, request or campaign grants none. Unclear/private whole-call evidence keeps future calls blocked, and completing staff work is not reconsent or hold release. |
| 13 | Selected confidential communication memo, exact verified subject and independent retention | Individual booking, observed cancellation/rescheduling, ordinary/pass class booking/cancellation and partial/completed movement reports now have local engineering evidence. This human/native acceptance row remains proposed and unexecuted. Verify approved content, author, confidentiality/viewers and retention separately from financial/contact reviews. A delayed or failed memo must not delay or repeat a known clinical result. Class memos identify the exact patient attendee and occurrence without claiming physical attendance, payment, remaining pass balance or a whole move. Exercise actual quota waits, response loss, wrong subjects and unavailable grants. Thirty-six synthetic booking/change/class killed-sender/full-restore cases now pass locally in the documented ordinary/approved-profile/same-case scope, including closed archived original reviews. Active clinical reads must continue refusing archived originals. Independently approve the exact native appointment source and its decoded marker; its review cannot substitute for that marker. Historical disclosure grants must remain current across final source waits. Withdraw the original-record grant during an account-budget wait and verify that no protected read starts; concurrent recovery of another permitted selection must retain its independent grant. Rehearse adult-representative individual booking with separate caller/patient codes and played consent; the memo must identify the selected patient, and another patient grant, withdrawal or lost memo ACK must preserve the known clinical result. Four emitted synthetic signed cases now have local engineering evidence, without making this real-clinic exercise complete. Rehearse adult-representative individual cancellation and rescheduling with separate caller/patient proof, exact native target and independently approved confidential memo binding. Synthetic signed coverage does not execute this clinic exercise; clinical ACK loss remains uncertain with no memo even when a separate native inspection matches. Rehearse guardian booking and individual cancellation/rescheduling for a native minor: actual birth date, separate clinic guardian authority and fresh caller/patient registered-channel proof must agree. A spoken relationship supplies no authority; inspect the confidential memo on the child, never the caller or another patient. Both adult and guardian synthetic cancellation cases retain accelerated received-media coverage using the authenticated decoder epoch; no real carrier timing acceptance follows. Synthetic signed guardian coverage does not execute this clinic exercise. Rehearse two independently approved patient booking tasks with separate registered channels and memo grants; verify each confidential memo is on its actual patient and that a pending prior memo cannot follow the new workflow. A lost first clinical response must block the next task without retaining a memo. Synthetic two-subject fixtures do not approve another operation, recording or real clinic workflow. For an approved self class booking, verify its confidential patient memo binds the actual occurrence, attendee and original attendance action without editing shared class notes or treating a pass as payment. Native capacity waiting requires actual waiting and fresh confirmation; memo uncertainty must not replay the clinical action. Synthetic cases do not execute clinic or financial acceptance. Broader source/subject/voice recovery and this real-clinic exercise remain pending. A partial or uncertain movement report must preserve separate original/replacement/association facts and never claim an atomic move, money or released credit. Other note types/attachments stay unselected; no shared-class disclosure or blind replay.  Include an outgoing original-patient booking, cancellation and rescheduling: independently observe the outbound confidential memo, patient/source binding and separate grants, and show denied or lost memo retention cannot undo known clinical success or release contact/capacity holds. When the clinical response is lost, inspect the native record independently and verify that Abby still speaks uncertainty, creates no memo and sends no replacement clinical mutation. |

For each completed row retain the trigger, expected versus observed fixed caller
wording, actual native outcome in private evidence, remaining obligations and
cleanup result. A failed or interrupted row remains failed/unresolved; a skipped
or unsupported row remains open. Record the actual clinic decision about the
remaining provider races and recovery ownership separately from test results.

## Closure

Reconcile the eventual full local result, exact-head CI, independent review,
all relevant operator rows and the still-open clinic/sender/speech/public-route
requirements in [the progress ledger](EXECUTION_PROGRESS.md). A green local
regression closes neither those acceptance gates nor the remaining thirteen-gap
scope. Keep the selected Cliniko financial-work ownership, real-mail and carrier deferrals,
provider activation and deployment decisions explicit.
## Optional signed outbound callback: acceptance still unexecuted

Local signed HTTP, actual emitted voice/SQL, killed-worker and logical-restore
tests qualify engineering under synthetic remote transports and clinic grants;
they do not record clinic/provider acceptance. Before relevant live traffic,
observe the selected actual account and original conversation policy, separate
native report/DNC/notification families and current grants, provider signature
handling/retries, and independently approved native/source restore behavior.
Confirm that unknown speech remains unknown, retained DNC survives notification
failure, and an uncertain unretained purpose cannot repeat its native write.
HTTP acknowledgement must not be presented as call end, contact settlement or a
clinical result. Existing clinic, carrier, acoustic and deployment gates remain
separate. See [the current local scope](OUTBOUND_STATUS_DELIVERY.md).

For an approved self class cancellation, check that its confidential memo binds the original reviewed cancellation, patient, occurrence and attendee only after acknowledgement plus inspection. Check all three clinic-approved pass cancellation effects without treating them as financial evidence. Native response loss stays uncertain and cannot create a memo fact or permit another cancellation.

## Unclear outbound contact: clinic review first, 22 October 2026

The owner selected staff review while future calls stay blocked. Local synthetic source/SQL/process/restore evidence is in [OUTBOUND_STAFF_REVIEW.md](OUTBOUND_STAFF_REVIEW.md); these clinic observations are unexecuted. Under separate explicit clinic/test authority, inspect a permitted unclear-contact pending record, its original possible-attempt and authenticated notification provenance, dedicated type/content, staff owner/viewer confidentiality, retention and restore behavior. Establish no successful-work claim when a native write remains unobserved. Verify before/after-storage loss and concurrent callbacks do not create another request or carrier call, denied permissions remain restrictive, and positive STOP retains DNC without requiring unrelated review permission. Staff opening/closing/acknowledging work must not release contact or count as reconsent/no-stop evidence. Verify the independent approved contact-decision and hold workflow before any future contact is considered. No recording, real API mutation/call, activation or deployment is authorized by this proposal.

## Class movement and required-financial memo follow-up, 22 October 2026

Local synthetic qualification is recorded in [the class follow-up](COMMUNICATION_MEMOS.md#signed-class-movement-and-required-financial-creation-follow-up-22-october-2026); it is not execution of these clinic acceptance observations. In an expressly approved disposable clinic, staff must inspect separate confidential patient memos for ordinary nonstaged moved/restored/needsReview reports and ordinary/approved-pass creation after independently played financial consent and clinical confirmation. Verify exact patient/native root, independent current permissions, duplicate/lost-response nonreplay, uncertainty wording, retention/viewer roles and restore handling. A financial consent or booking memo must never be presented as payment, waiver, refund or atomic movement. Existing clinical/shared-class notes stay unchanged. Other class/representative/financial combinations need their own acceptance. No real API write, contact launch, recording or activation is approved by this proposal.

## Consistent recovery export while other work continues, 22 October 2026

The [local correction](OUTBOUND_STATUS_DELIVERY.md#consistent-full-restore-snapshot-22-october-2026) is synthetic engineering evidence, not clinic restore acceptance. In a separately approved disposable acceptance environment, capture one consistent full source snapshot, retain complete expected opaque effect/hold history at that same point, and verify the restored database against it while independent legitimate work continues. Preserve unrelated records and full private-data scanning. A later live table may contain new rows without invalidating an earlier coherent backup; it must not be silently substituted as that backup's expected state. Then verify current native grants, no replay, preserved uncertainty/held contact and exact native receipts after recovery. Actual clinic/source/retention/provider acceptance, live traffic and activation remain unexecuted and unauthorized by this proposal.

## Concurrent active read and cancellation observation, 22 October 2026

The synthetic witness in [the concurrent financial fixture correction](STRIPE_FINANCIAL_CONTRACT.md#concurrent-native-fixture-correction-22-october-2026) now forces an active native attendance read to complete after another independently admitted owner cancels. In any separately approved disposable acceptance exercise, verify current query/filter semantics and native status observations without inferring extra cancellation, financial or replay authority from a stale read. This is a proposal; actual clinic/provider concurrency, money/waiver policy and patient traffic remain unexecuted. The historical source-only fixture failure and its correction grant no activation.

## Composed staff-review evidence is not clinic acceptance, 22 October 2026

Current [staff-review qualification](OUTBOUND_STAFF_REVIEW.md#fresh-composed-qualification-on-published-parent973-22-october-2026) uses the actual signed/media/native owners with synthetic remote services, source 265/strict 726/one SQL28 graph, real worker loss and two complete restores. The earlier proposed clinic observations remain unexecuted: staff ownership/viewing/retention, current contact-review/source grants, unresolved-work visibility, real carrier/acoustic coverage and restore behavior. In a separately approved disposable exercise, confirm pending tasks do not release contact or rewrite uncertain audio into a whole-call no-stop result. No recording, live traffic or activation follows from local qualification.

## Concurrent authentication and outbound privacy, 22 October 2026

The synthetic outbound verification cases now own migrated case databases inside an admitted disposable server. Full application scanners/backups remain unfiltered, and a separate positive leak-detection probe still includes authentication digests. Normal concurrent qualification preserves every shared application row and 401 independent administrative digests. This test isolation is not a production storage migration or an exemption for authentication data. Any separately approved real acceptance exercise still needs clinic/provider source, consent, retention, privacy and restore evidence. No patient call, clinic write, money movement or activation is authorized by these local witnesses.

The reviewed unrelated phone sentinel is structurally disjoint from the ending-zero synthetic SQL canary space. This is a pre-issuance fixture invariant; it does not suppress a recorded secret, omit an allowed phone-index row or weaken a production scanner. The refreshed current engineering checks are recorded in [the isolation qualification](COMMUNICATION_MEMOS.md#isolated-outbound-verification-privacy-witnesses-22-october-2026).

## Staged movement report observations, 22 October 2026

The signed staged qualification uses synthetic remote services. In a separately approved disposable exercise, observe renewed proof and played confirmation for each original/replacement/association phase, compare actual pass counters with response certainty, and confirm a partial/disposed report cannot continue a clinical stage. Verify independent patient memo grants and uncertain retention without permitting another write. The source cohort supplies no new worker-loss/full-restore or real clinic/privacy/retention/carrier/acoustic acceptance. These observations remain proposed and unexecuted; no live traffic, recording or activation follows.

## Combined staged and catalogue memo observations, 22 October 2026

Synthetic engineering now covers one composed145-source/726-output/31-test graph:30 emitted signed SQL cases and one preserved source E2E with13 internal modes. In a separately approved disposable clinic exercise, observe exact approved service/type/duration, fresh proof after an unsent service correction, played per-phase consent, original versus replacement/association certainty, and independently permitted memo storage or unresolved acknowledgement. Check the native confidentiality/viewer, source, staff owner and retention/restore contract separately. These real clinic/provider/carrier/acoustic observations remain proposed and unexecuted. Current synthetic success supplies no new cold recovery/worker-loss/full-restore proof, live traffic, money, recording, contact release or default activation.

## Explicit finite exact sick-day scheduling, 22 October 2026

The local finite scheduler qualifies synthetic exact-appointment pending requests, not an inferred sick-practitioner/day audience. A separately approved clinic exercise must confirm the intended pending source, current exact target policy, scheduling/contact/DNC permissions, human owner, real provider profile and unresolved-contact procedure. Exercise late appointment/permission withdrawal and unknown launch without another call. Clinical disclosure and actions still require independent caller verification and their existing consent/authority owners. These real observations remain proposed and unexecuted; no calls, clinic writes, recording, contact release or activation are authorized by the local results.

## Optional transcription settings: acknowledgment acceptance

Under separately authorized provider testing, inspect the effective session acknowledgment for each requested delay or noise-reduction option. An omitted optional field is unverified; do not label a requested profile confirmed from successful transcription alone. An explicit mismatch must retire transcription, including a changed configuration during a pending turn, without accepting late text or reopening the socket. The current 36 synthetic controls and strict/726 build qualify the protocol correction only. Fixed noisy/safety/latency thresholds and representative microphone, accent, public-route and carrier acceptance remain unexecuted or failed as previously recorded. No new live provider evaluation, paid call or acoustic pass is recorded here.

## Verified incoming callback and separate memo: proposed observations

These observations complete the proposal for the [verified callback and memo
composition](INCOMING_MISSED_CALL_CONTEXT.md). They remain unexecuted. The local
438-source callback result, four original signed cases and five additional memo
modes are synthetic engineering evidence with their separate recorded scopes;
they do not supply these real clinic/provider/acoustic observations or current
normal delivery. Pin the actual accepted source/build before an independently
authorized exercise, with a clinic staff owner and an approved patient-free
environment. Use that clinic's approved timezone and allied-health service.

| Trigger | Required observation |
| --- | --- |
| A sick-day original names the later of two appointments; an incoming caller asks why the clinic rang before verification. | Abby retains the unknown-reason response without disclosing the patient, purpose or appointment. Shared-household, wrong-patient, expired, ambiguous and withdrawn-source variants also refuse disclosure; a number or campaign is not patient authority. |
| The correct subject independently completes the registered-channel read verification and asks again. | Current approved request, possible attempt and authenticated completed/no-answer evidence agree. Abby gives only the approved follow-up or rescheduling purpose. An absent or conflicting source stays unknown. Verify the actual clinic record/grants privately; caller speech alone supplies no campaign provenance. |
| The caller requests a move after hearing the reason. | A new rescheduling code and current operation authority are required. Played original-target/offer choices and final consent precede one native review and mutation of the campaign original; the earlier appointment remains unchanged. Empty general lookup may expose only the independently checked original; a contradictory populated lookup refuses. A changed/cancelled original, revoked grant or exhausted physical quota prevents dispatch without silently selecting another target. |
| A separately approved confidential communication memo is selected for the successful observed move. | Inspect the exact verified patient, original appointment, inbound direction and actual clinical review marker under independent native permissions. Its content/category/API author/viewers/retention must match clinic approval. No transcript, diagnosis, private code, appointment/treatment note edit or shared-class text is introduced. Purpose disclosure grants neither memo nor clinical authority. |
| The memo grant is for another patient or is withdrawn before confirmation. | The correctly authorized clinical result remains truthful; no memo or memo-purpose claim occurs. Staff must not report a saved memo from the clinical confirmation. |
| The clinical acknowledgement or memo acknowledgement is lost. | A clinical unknown remains uncertain and creates no memo. A lost stored memo acknowledgement preserves known clinical success while leaving memo retention uncertain and its one-use purpose spent. An outcome question or a new owner cannot replay either send. Any recovery requires its independently approved native history/source path; this proposed exercise does not establish cold recovery or restore by itself. |
| The first incoming call ends and a new signed incoming owner asks the same reason. | It needs its own read verification before fresh clinic-native context can be disclosed. It cannot inherit the first owner's proof, context, write consent or memo permission. Inspect SQL columns and the complete unfiltered backup for private context/code/session/memo leakage while retaining unrelated records. |

Retain fixed expected-versus-observed wording, native outcome and unresolved
obligations in the clinic-approved private evidence destination, plus cleanup
and staff ownership. Keep real identifiers and private source material out of
the repository. Future outbound contact/capacity decisions retain their own
owners; a reason, clinical success, memo, completed notification or closed staff
task establishes no complete whole-call no-stop truth or contact release.
No recording, deferred carrier traffic, payment, deployment or default
activation is authorized by this proposal.



## Shared native budget storage and completion coverage, 22 October 2026

The new local [budget storage guard](SHARED_BUDGET_STORAGE_READINESS.md) does
not execute clinic acceptance. In a separately approved disposable environment,
confirm the deployed PostgreSQL version/role exposes the supported budget
catalog properties and that a compatible exported runner starts. Keep normal
clinic admission, speech quality and all patient/provider grants independent.
With only the owned test database, remove a required table/column or disable its
hold guard: startup must refuse before listening, and an existing listener must
return503 for a fresh signed webhook or reject a later stream without provider
creation. A successful SELECT1/health ping is insufficient. Observe a repair
through a new call; never replay a denied or uncertain clinical action or claim
that an old active result was undone. No automatic migration/repair is supplied.

Known application-session expiry, aggregate counts, native review queue health
and one captured outbound root do not cover a carrier call never admitted by
Abby. Record that explicit limitation. Any independent completion inventory
needs separate current source/coverage/grant qualification under R01; a native
queueKnown result or absent local event cannot prove that an uncertain booking
was never sent. These observations remain proposed and unexecuted. No private
call ledger, live carrier/clinic request, deployment or activation is authorized.
