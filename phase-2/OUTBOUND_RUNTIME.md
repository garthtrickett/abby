# Outbound voice runtime adapters

The owner requested interchangeable Abby and Vapi runtime support on 19 October 2026. Use the existing Abby voice implementation as the starting path; selecting a hosted runtime must not require rewriting clinic workflows. This is an engineering direction, not authorization to place calls or activate provider credentials.

## Responsibilities

| Module | Responsibility |
| --- | --- |
| Abby workflow owners | Current audience/clinic approval, contact consent and DNC, quiet hours, capacity, permanent one-use exclusions, native request/possible-attempt records and independent clinical action authority. |
| Selected runtime adapter | Phone transport plus the selected conversation runtime, exact provider acknowledgement parsing, authenticated complete call lookup/correlation and provider-specific failures. Twilio plus Abby and Twilio plus Vapi can supply the same interface. |
| Conversation-to-clinic adapter | Route requests through Abby's existing verification, fresh appointment, readback/confirmation and clinical action owners. Model text and generic tool calls are requests, not permission or proof of a booking. This adapter still needs implementation and end-to-end qualification for a hosted runtime. |
| Cliniko and Stripe | Remain the owning native sources for their respective appointment/contact/financial records and money operations. A completed call does not prove an appointment or payment outcome. |

## Implemented interface

`src/voice/outbound-runtime.ts` owns the provider-independent contracts. Existing launch/terminal-owner type exports remain compatible. `bindOutboundVoiceRuntime(adapter)` selects one trusted implementation and supplies `runtime.launch` and `runtime.terminal` to the existing owners. Launch and completion recovery therefore use one pinned selection rather than independently assembled provider identities. Inject these ports at composition; do not branch on provider names in clinic workflows.

The selected non-patient identity includes a reference, effective settings/credential digest and conversation profile. Its digest must cover both transport account and conversation runtime, including effective credentials/profile/settings. Choosing Vapi with the same Twilio number is still a different selection requiring current approval. Changed reference/digest/profile invalidates previously captured ports. Existing attempts remain bound to their original runtime; the new runtime cannot adopt, retry or declare those calls ended.

After the native possible-attempt ACK, the owner also supplies an optional private original-send handoff as a separate fifth workflow argument. The wrapper captures and validates the complete canonical original attempt; the concrete guarded Twilio adapter requires it. This volatile private context is distinct from the four-field public payload and grants no clinic read or patient proof. See [transport contract](TWILIO_OUTBOUND_TRANSPORT.md).

The launch payload contains only an opaque effect reference, opaque capacity allocation reference, dialled number and approved profile reference. It contains no native appointment, patient proof, Cliniko credential, transcript, financial record or clinic grant. The number is private transient input; the adapter may not introduce a local patient-bearing queue, map, phone hash or recovery ledger. Provider/clinic-owned durable truth remains necessary for crash recovery.

`launchOnce` receives Abby's one-use final dispatch fence. The implementation must finish every internal wait first and invoke that fence immediately before its only dispatch. A repeated or late fence refuses. Exact parsed acknowledgement is distinct from connected/delivered/completed or clinically successful. Known acceptance survives cancellation or a later observer failure. Once an adapter was invoked, malformed, lost, refused or uncertain results remain conservative; this module never retries or falls back to another runtime. Permanent SQL exclusions remain the deduplication authority.

`inspectTerminal` requires trusted authenticated complete provider evidence for every possible call with the exact effect/allocation pair. Missing rows, a raw callback, silence, process absence or one completed call leg cannot establish completion. Exact complete terminal results are normalized; extra/foreign/private response fields, changed identity, cancellation and malformed versions stay unknown. Only the separate terminal owner can authorize capacity release after its own native reread and current grants. Completion never clears permanent effect exclusions or DNC.

## Concrete adapter requirements still open

The current inbound Twilio/Abby audio loop is not silently converted into an outbound transport by this module. The [conditional Twilio transport](TWILIO_OUTBOUND_TRANSPORT.md) now supplies single-dispatch creation, encrypted original-send correlation and authenticated answer/status/media-start recovery. The [optional signed HTTP/media ingress](TWILIO_OUTBOUND_INGRESS.md) now supplies typed outbound routes and permanent one-use session admission. Complete final-report/ALL-call terminal recovery, actual conversation composition and independently verified clinical callback still need implementation and qualification. Actual Vapi launch, event authentication, native recovery and the conversation-to-clinic adapter also remain unfinished. No real Vapi integration or two production-ready runtime implementations are claimed by synthetic conformance fixtures.

A Vapi implementation must preserve Abby's exact prompt/playback/confirmation and correction rules, not merely expose an unrestricted booking function. It must authenticate and correlate events, preserve uncertainty and independently qualify speech delivery/cancellation evidence. Automatic stop reports require the separate clinic-approved unknown-consent/blocked-DNC policy and number-wide suppression/recovery; call completion and model summaries do not supply that authority. Reconsent remains clinic-approved. Unsupported evidence or capabilities must refuse.

Activation must be explicit for a clinic and profile. There is no automatic provider registry, runtime failover, default outbound listener or new local schema. This interface allows implementation changes behind a stable seam; it does not make an unimplemented runtime a configuration-only switch.

## Conditional automatic native stop owner, 19 October 2026

A conditional owner now consumes exact v3 native context and a trusted durable authenticated-provider stop observation under current clinic-approved policy to retain unknown-consent/blocked-DNC decisions. Separate decoded history export and native/current/producer grants apply. Stable IDs, one-use exclusion, archived/closed recovery, later approved reconsent and unknown writes preserve conservative behavior. Final 95 composed source controls, 49 complete codec/lineage controls, strict TypeScript and the required serving build and nine emitted SQL/native 180-request/privacy cases pass. This does not implement raw provider authentication, number-wide suppression or unresolved-stop call admission; concrete runtime/verified callback and clinical handoff remain open. No activation follows. See [contract and remaining requirements](OUTBOUND_STOP_RECOVERY.md) and [exact evidence](EXECUTION_PROGRESS.md#conditional-automatic-native-stop-recovery-19-october-2026).

## Exact sick-day launch extension, 19 October 2026

An explicit appointment-policy configuration and independent native target plus `approveAppointmentTarget` grants now allow the one-shot owner to prepare sick-day calls against the exact original future appointment. Target/version and policy fingerprint are stable; fresh rereads after waits and final current/start-time fences refuse changes or invalid status. The default follow-up composition and its grants are unchanged; targeted follow-up and sick-day scheduler expansion remain unsupported. The provider still receives no appointment or patient proof. 95 source controls, final strict/required serving build and nineteen emitted SQL/native 180-request/runtime/privacy cases, including two real SIGKILL/positive archived-history recovery cases, pass. Concrete runtime, number-wide DNC and verified clinical callback remain unfinished; no activation follows. See [exact contract](OUTBOUND_TARGETED_LAUNCH.md) and [evidence](EXECUTION_PROGRESS.md#exact-sick-day-call-launch-19-october-2026).

## Explicit outgoing admission prerequisite — 20 October 2026

The [outbound admission contract](OUTBOUND_CALL_ADMISSION.md) separates the public clinic number from the incoming dialled-number role, rejects private/mixed durable shapes and preserves existing session lifecycle and incoming location routing.38 source passes, full strict TypeScript/646-artifact serving-test build and68 actual emitted SQL/incoming controls pass; exact new-head cloud qualification still follows. This does not implement the actual outgoing conversation or immutable complete final reporting, release provider/contact holds, prove a patient or enable a clinical callback. The standalone rich-storage restriction remains unchanged.

## Conditional Abby conversation implementation — 20 October 2026

The [actual Abby conversation factory](TWILIO_ABBY_OUTBOUND_CONVERSATION.md) now shares the real session/media/playback owner with incoming calls through direction-specific entries. The outgoing profile is current, outgoing-purpose/time-bound and bound to physical model/media/speech settings; it supplies no incoming caller clue or verified patient.Current combined qualification passes93 source controls, full strict/652 build,27 emitted native180 SQL/crash/backup cases and both actual incoming financial offer-prefix journeys. Approval and operation cancellation are rechecked after asynchronous transcription as well as before it. Earlier incoming/staged evidence retains its recorded source. Corrected3d passed all exact-head jobs and merged as4662f95; its actual automatic main run also passed. Original private context stays volatile; no private local map or patient-bearing SQL is added. Runtime terminal inspection remains unknown until immutable complete provider/contact/speech reporting is built. Original-patient/exact clinical authority, Vapi implementation, default wiring and clinic/provider acceptance remain distinct.

## Authenticated native report evidence foundation — 20 October 2026

The [native report records](TWILIO_OUTBOUND_REPORT_RECORDS.md) retain signed-content evidence in a dedicated clinic-owned family under exact original-send matching, current key-specific grants, native180 quota and a permanent opaque report action. Positive stop evidence may precede call closure; complete-no-stop data requires terminal evidence. Current56 source,655 full strict/build and eight actual emitted SQL/cold/native-history/backup cases pass locally; final test-only canary formatting has focused typing and preserved artifacts. New-head cloud qualification remains required. Actual speech/stop production, number-wide recovery, all-call/speech closure, cross-version verifier retention and settlement composition remain next; the runtime still returns terminal unknown and releases no holds.

The report foundation's initial shared-cloud privacy run exposed a fixed test-key/public-profile-hash alias. The exact failure is reproduced and the scoped test-only correction passes focused strict checking and9 emitted native180/backup cases, including an actual-key injection control; all655 serving artifacts remain unchanged. Revised-head cloud qualification is pending. This changes no runtime report authentication, source permission, quota, privacy scanner or hold-release semantics. See EXECUTION_PROGRESS.md.

The [concrete signed native stop recovery](TWILIO_OUTBOUND_STOP_RECOVERY.md) now composes the selected Twilio runtime's actual signature/context checks, exact MAC native report/history and the existing clinic-approved automatic DNC owner. One physical native180 budget covers every report/original/contact/DNC request. Actual CallSid/original digest and current report grants remain fenced; no-stop/missing evidence stays unresolved.26 focused source controls, full strict/656 build and7 actual emitted PostgreSQL/backup cases pass locally; publication/cloud qualification follows. This is no speech stop producer, all-call finalizer, default HTTP receiver or hold release. Continue those actual compositions and independent exact-subject clinical handoff.

PR564's combined prerequisite/secret-fixture refinement preserves its serving source and656 artifacts.26 current source controls, focused strict and16 combined emitted SQL cases (report9/recovery7) pass with actual MAC/context keys and Twilio token included in all-column/raw-backup checks beside the legitimate public profile. Exact combined-head cloud qualification follows. No HTTP receiver or actual speech producer is inferred; those remain subsequent composition work.

The [actual optional signed stop receiver](TWILIO_OUTBOUND_STOP_RECEIVER.md) now runs concrete native recovery inside the existing authenticated Node request lifetime/current grants. An explicit opt-in hook owns private signed material; ordinary progress keeps two arguments. Terminal missing/uncertain evidence is retryable503, authentic no-stop is delivery-only204, and accepted/discovered DNC is204 without hold release.59 source controls, final complete strict/657 build and7 emitted two-server SQL/callback/patient/backup privacy cases pass locally; publication/cloud qualification follows. No default route, detached task or local private retry ledger is activated. Actual speech stop production, complete finality and independently verified clinical handoff remain separate.


The [optional positive speech-stop producer](TWILIO_OUTBOUND_STOP_SPEECH.md) now
connects the actual assembled outbound turn to native report production and the
same DNC recovery engine. Its selected profile is approved before speech, and
the owned disconnect tail awaits independent bounded native retention after
voice closure.62 focused source controls and strict fixture types pass;
whole strict/667 serving build,129 existing voice controls and9 emitted SQL/privacy cases also pass. Publication/cloud qualification follow. This supplies no no-stop
coverage, complete all-call/provider finality, hold release or clinical authority.
Report/recovery/receiver foundations through PR565 are normally merged with all
exact-head cloud jobs green; actual merged-main qualification is separately
recorded in EXECUTION_PROGRESS.md.


The subsequent approved-profile version2 conservatively closes an exact whole
stop phrase at uncertain ASR quality without report/DNC retention. The real
OpenAI adapter's uncertain quality is unchanged. Revised63 source, focused
strict types, full strict/667 serving build and10 emitted SQL/privacy cases
pass. Two original PostgreSQL/TLS browser login journeys pass after explicit
image preparation outside the unchanged10-second launch deadline. Revised
exact-head cloud qualification follows; this does not promote NoStop/finality,
clinical authority, real acoustic acceptance or activation.


### Conditional positive finality — 20 October 2026

PR566's conservative speech-stop revision passed all eight exact3ef2cde cloud jobs and merged asd7f251c; actual main is separately monitored. The new [positive-only finality composition](TWILIO_OUTBOUND_FINALITY.md) has local native/provider/source, strict/current672 serving and ten actual emitted SQL/native180/process-loss/full-privacy passes. It rediscovers MAC-bound original native context from the runtime pair without inventing lost session/report IDs, requires independently current complete all-creation/mutation/restore single-root approval and fresh provider reads, then invokes the existing separate native contact-outcome and call-capacity owners. The same physical budget and one purpose-wide180 ceiling cover all native requests. Early reports and consumed actions are not rewritten or replayed.

Its own exact-head cloud qualification/review/merge remain required. This does not activate an HTTP handler, scheduler or live backend. Complete no-stop/all-ASR drain, independent original-patient/exact clinical authority and gap13 remain open. Actual OpenAI quality is still uncertain; conservative unclear stop closure without native positive evidence keeps its holds. Synthetic clear speech/provider fixtures do not establish clinic, carrier, acoustic or restore acceptance. See the [execution ledger](EXECUTION_PROGRESS.md) for complete source, failed refinements, emitted/process/SQL evidence and current publication status.
