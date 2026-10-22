# Verified incoming missed-call context

This opt-in Cliniko component implements the verified callback part of
[R21](KAREN_TO_ABBY_REUSE_AUDIT.md#r21-pin-the-exact-sick-day-or-callback-appointment-end-to-end)
and [execution stage 9](EXECUTION_ORDER.md). The callback foundation normally
merged as PR587 at c3af48c after all eight own-head jobs and their raw logs
passed. Its actual-main checks are separately tracked. This local callback-memo
follow-up is integrated with that actual parent and retains its own review,
publication and cloud checks. It enables no clinic or provider by default and does not complete the thirteen-gap roadmap.

## Caller behavior

An independently verified incoming caller can ask why the clinic called. Abby
reads the clinic-approved native original request, possible attempt and
authenticated provider notification. An unambiguous approved follow-up produces:

> The clinic called about arranging a follow-up appointment. I can help with
> that, or you can contact reception.

An approved sick-day original produces:

> The clinic called about rescheduling your appointment. I can help with that,
> or you can contact reception.

Missing verification, an ambiguous household, another patient, stale or
conflicting evidence, unavailable grants and an altered original retain the
existing explicit unknown-reason reply and clinic contact path. There is no
lookup by guessed campaign, most-recent native ID or soonest appointment.

Explaining the reason supplies no clinical permission. A subsequent move or
cancellation needs its own operation-specific code and current approvals. The
original appointment remains a constraint even when another appointment is
earlier or a general lookup is empty. A contradictory populated lookup refuses;
an empty lookup can expose only the independently checked original. Changed
native source, raw target version, contact, permission, terms or grants block
dispatch. Played choices and final consent precede a native review and one
possible mutation. Response loss stays uncertain and cannot replay that send.

## Authority and native reads

`ClinikoCallFlowConfig.missedCall` is optional incoming-only provisioning. The
clinic selects separate request, attempt and notification types, account/key,
content and target policies, explicit recency and current read grants. These
records are separate from financial/contact reviews. The normal reusable voice
host supplies the actual signed admission, session, lifetime and verifier.

`ClinikoIncomingCallContext` accepts the actual independent
`CallerVerificationSession`, with the same clinic account and physical budget.
It validates the native subject immediately before every protected HTTP
dispatch and before returning a result. Private routing and permission gates
can check the existing reference without repeatedly fetching contact data;
that reference does not authorize a protected read.

Two fresh patient-scoped archived-inclusive history scans bracket the read.
The existing limits remain five pages, 500 total rows and 50 selected records
in aggregate. Native metadata, full decoded-record grants, original digests,
provider authentication, destination number and source/account relationships
must agree. Multiple eligible notifications or another possible attempt in the
approved window refuse. This is bounded observed evidence, not an atomic
snapshot or proof of global absence.

The internal `PatientRecallSnapshot` can be created only by a real bounded
native history read. Its private rows are bound to account, patient, selected
families and the exact operation signal. Record adapters keep their normal
selection/body grants and existing codecs while avoiding duplicate GETs for a
body already fetched in that operation. The final scan detects version changes;
the snapshot expires with its operation. No cross-call cache or local native
record journal is added. Exact target version bindings retain native timestamp
precision; caller-facing dates normalize separately.

## No-answer notifications

A Twilio completed event can carry a no-answer call status. An explicitly
selected `unansweredCallObservationBinding` uses a separate authenticated
no-answer protocol, native family and permanent one-use retention purpose.
Legacy completed-record bytes, action/digest/MAC domains and key binding remain
unchanged. Both families share only their private canonical codec mechanics.

The optional signed HTTP delivery branch runs restrictive DNC recovery first,
then the selected notification owner, under one deadline and cumulative native
allowance. Cold permitted native reads can find a retained acknowledgement;
an unretained spent purpose cannot send another POST. No-answer evidence proves
neither whole-call opt-out completeness nor patient/contact/clinical authority.
It does not run the completed-only staff review or release call/contact holds.

## Qualification and limits, 22 October 2026

The complete current production graph passes 438 source controls: 68
incoming/native/clinical cases and 370 preserved native, outgoing and
rescheduling controls. The frozen legacy completed codec comparison is exact.
Fresh whole strict TypeScript and the actual serving build pass with 740
outputs, independently hashed.

Final boundary review first reproduced two direct JavaScript constructor
failures at the intended factory boundary. An unexported runtime owner now
prevents unfetched rows from constructing a snapshot. The same controls pass
alongside the complete regression. This changes only the snapshot output; the
other 739 serving outputs remain exact against the prior qualified bundle.
Earlier budget, constructor and fixture failures remain preserved.

The complete source rescheduling journey uses 173 native HTTP requests plus one
setup request under the unchanged physical 180 limit, with zero denials. It
uses read and new rescheduling codes, played menus/consent, one review and one
PATCH of original appointment 71, followed by acknowledged/fresh inspected
success. Earlier appointment 70 stays untouched. The owning budget failures
before the redundant-read correction remain preserved; no limit or deadline
was raised to obtain the pass. Source cancellation also retains its complete
fixed-budget positive and failure controls.

Four actual emitted signed HTTP/WebSocket PostgreSQL cases pass: accepted move,
original changed before affirmation, competing native quota and two fresh
incoming owners. A fresh owner cannot inherit verification and must obtain its
own code before rereading the unchanged clinic original. All-column canary scans
and unfiltered database backups exclude native/private context, codes and
session identifiers after call closure; unrelated seeded state stays intact.
These use the normal transient clinical ledger and durable SQL guards, not
patient-bearing durable call state.

Reproduction entry points are
`test/contract/incoming-clinical-call-flow.test.ts`,
`test/contract/incoming-clinical-rescheduling.test.ts`,
`test/contract/incoming-clinical-context-privacy.test.ts`,
`test/cliniko/incoming-call-context.test.ts`,
`test/cliniko/patient-recall-snapshot.test.ts` and
`test/storage/postgres-incoming-clinical-voice.test.ts`. The SQL file requires a
current `npm run build:voice-tests` and isolated PostgreSQL, with explicit Node
and database resource limits. Source and serving inputs must match the tested
snapshot before reusing evidence.

Remote Cliniko, carrier, mail, grants, clear-final recognition and synthesis are
synthetic. Fresh owners are not a killed-process/full logical-restore proof.
Real clinic/native-source/retention/provider/acoustic acceptance, deployment,
default activation and the remaining full roadmap retain their separate gates.
`E2E-424` and `E2E-425` record synthetic evidence; full-call evidence stays planned.

## Independently approved callback memo composition, 22 October 2026

The optional existing administrative-memo owner now has actual signed callback
composition evidence. The incoming caller obtains a read code, hears the
verified sick-day purpose, then obtains a separate rescheduling code and plays
the original target, offer and final consent. A successful observed move creates
one confidential inbound communication memo for the verified patient and
`cliniko:appointment:71`. Its source is the actual clinical review marker,
not the earlier outbound attempt or the reason-disclosure grant. Earlier
appointment 70 remains unchanged.

Five new modes cover accepted retention, a different patient's memo grant,
withdrawn memo permission, stored memo acknowledgement loss and clinical
acknowledgement loss. Memo denial preserves known clinical success without
consuming a memo purpose; a lost memo acknowledgement stays uncertain with its
purpose spent. A lost clinical acknowledgement creates no memo or memo purpose.
An explicit later outcome question changes neither the clinical action nor the
number of clinical or memo sends. The SQL barrier independently refuses a
second claim for either stored memo, and each memo source matches the native
review exactly.

The complete nine-case signed SQL file passes: these five and the four preserved
incoming cases above, with no skips or cancellations. Whole strict TypeScript
passes. Only the nonemitted SQL driver and documentation change; all 740 copied
parent serving outputs are hash-identical, with no rebuild or newly claimed
438-source run. The same native180 budget, verification, played confirmation,
independent grants and all-column/unfiltered raw-backup privacy checks remain,
including the memo content and key. Node peaked at 183,259,136 B and the owned
PostgreSQL at 124,637,184 B, each capped at 512 MiB/CPU100%/Swap0 with no OOM,
high or max event. Both completed naturally and database cleanup passed.

The parent PR587 normally merged atc3af48c after its eight own-head jobs and
raw logs passed. The actual normal parent is integrated with all source and740
runtime outputs unchanged; its actual-main checks remain separate. This
follow-up retains its own exact-normal review, publication/CI and normal
delivery checks. No current memo recovery, killed sender,
restore, real clinic/provider/acoustic acceptance or activation is established
by this cohort. It extends the existing owner-selected communication-memo
operation, leaving appointment/treatment notes and contact decisions separate.
