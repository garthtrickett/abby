# Positive outbound speech-stop producer

This optional trusted-host composition connects an actual signed Twilio/Abby
conversation to an authenticated native stop report and the existing
clinic-approved restrictive Cliniko DNC owner. It does not activate a listener
or campaign. The report and decision require their own current native grants.

The clinic conversation approval includes `stopSpeechBinding`, calculated before
runtime construction from the native report source, verifier-key fingerprint and
fixed positive phrase grammar. The concrete runtime is then constructed with
that conversation profile; report authentication is constructed afterward. This
avoids a profile/runtime/authentication cycle. A missing or changed selected
producer binding denies the conversation before speech. Without this optional
feature, existing profile projections and inbound admission remain unchanged.

The actual conversation factory installs the captured producer policy on the
`VoiceSession` before attachment. Only an admitted outbound session can use it.
The gate inspects the actual assembled final caller turn before intent, model,
conversation control or clinical workflow handling. Partials are not assertions.
The initial bounded English whole-turn grammar recognizes explicit requests
such as “please stop calling me” and “remove my number from your calling list.”
Negation, quotations, reported speech, unclear recognition and unsupported
language are not promoted to positive evidence. An unmatched phrase never proves
no-stop coverage. Classifier failure closes the conversation without fabricating
a stop report. An exact whole stop phrase with uncertain quality now closes
conservatively without signing positive evidence or writing a DNC. The real
OpenAI transcription adapter currently marks every final `needsClarification`;
that safeguard remains unchanged. The positive grammar/profile descriptor is
version2 so this behavior requires the matching new approved binding. Acoustic,
language and clinic acceptance remain required.

A positive turn immediately fences further speech and ordinary work, cancels
transient work and closes the transport. Independently bounded native retention
then uses the original preallocated report action and exact original patient,
possible-attempt digest, account, physical CallSid and dialled number. It signs
`stopRequested` with `terminal:null`, retains it once in the dedicated native
report family, and invokes the SAME native MAC/history/original/current-grant
recovery and DNC engine. It does not fabricate a signed status callback. Both
native purposes remain independently authorized after voice abort. The owned
receive/disconnect tail awaits them; no detached retry task is introduced.

One report POST plus the configured recovery allowance must fit the existing
physical native180 budget. Recovery is limited to179 requests in this composition
so its report POST is included. The producer checks that aggregate headroom;
report retention and every recovery read/write also claim the same physical
budget. Report retention uses its existing maximum15-second deadline; recovery
keeps its existing configured maximum120 seconds. The outer native purpose is
bounded to at most120 seconds and aborts stalled headroom as well. No application
quota, permission, deadline, SQL exclusion or test assertion is increased.

An uncertain report response may be discovered from native history without a
second report POST. An exact stored DNC can similarly be discovered cold. An
uncertain unobserved write stays consumed. Closing the voice connection never
means that a native report or DNC was saved. Both campaign and clinic-wide
contact holds stay retained, including when permissions, budget, source or
acknowledgement are unavailable. No patient/call/number/transcript/private-key
recovery map is stored in Abby SQL.

This preterminal positive report cannot be overwritten or replayed to add later
finality. Complete all-call/provider/contact reporting still needs separately
qualified immutable evidence and any distinct final-purpose IDs allocated before
the original send. Missing audio, private ASR-suppressed intervals, unclear or
unsupported language, producer loss and shutdown tails cannot be ignored to
claim no-stop. Original native routing is not responder verification or exact
clinical authority. Source/verifier history, restore qualification, independent
clinical handoff, gap13 and real acceptance remain separate obligations.

Initial published c0d35e9 qualification is recorded in
[the progress ledger](EXECUTION_PROGRESS.md):62
focused source controls,129 existing shared-voice/embedded/endpointing/signed
outbound controls, focused strict types, full strict TypeScript/667 emitted
artifacts and9 actual emitted-code PostgreSQL cases pass. The SQL cases include
separate workers, exact one-use report/DNC effects, both retained holds, native180
quota and all-column/full-backup checks over patient/contact/call/session,
report/context keys, MAC, entire native notes and launch URLs/form. No skip,
quota increase or scanner filter was introduced. Publication and exact-head
cloud qualification follow; no activation or real acceptance is inferred.

The conservative uncertain-stop refinement first failed its actual signed-voice
red control (ordinary reply instead of closure), then passed that same control.
Current profile2 passes63 combined source controls, focused strict typing,
full strict TypeScript/667 serving artifacts and10 actual emitted PostgreSQL
cases including uncertain stop closure without report/DNC action consumption.
The two unchanged real PostgreSQL/TLS browser login journeys also pass with
the image prepared before the existing startup deadline. Exact revised-head
cloud qualification follows; initial results are not substituted for new source.


### Conditional positive finality — 20 October 2026

PR566's conservative speech-stop revision passed all eight exact3ef2cde cloud jobs and merged asd7f251c; actual main is separately monitored. The new [positive-only finality composition](TWILIO_OUTBOUND_FINALITY.md) has local native/provider/source, strict/current672 serving and ten actual emitted SQL/native180/process-loss/full-privacy passes. It rediscovers MAC-bound original native context from the runtime pair without inventing lost session/report IDs, requires independently current complete all-creation/mutation/restore single-root approval and fresh provider reads, then invokes the existing separate native contact-outcome and call-capacity owners. The same physical budget and one purpose-wide180 ceiling cover all native requests. Early reports and consumed actions are not rewritten or replayed.

Its own exact-head cloud qualification/review/merge remain required. This does not activate an HTTP handler, scheduler or live backend. Complete no-stop/all-ASR drain, independent original-patient/exact clinical authority and gap13 remain open. Actual OpenAI quality is still uncertain; conservative unclear stop closure without native positive evidence keeps its holds. Synthetic clear speech/provider fixtures do not establish clinic, carrier, acoustic or restore acceptance. See the [execution ledger](EXECUTION_PROGRESS.md) for complete source, failed refinements, emitted/process/SQL evidence and current publication status.

## Bounded terminal public-tail qualification

The separate [terminal public-speech owner](OUTBOUND_TERMINAL_SPEECH.md) qualifies actual queued wire/socket closure and already admitted public ASR without a clinical turn. Current111 source controls, strict/683 serving build and31 emitted SQL/process-loss cases pass. Its producer binding now includes `abby.twilio-stop-speech.v2` and `boundedPublicTerminalASRWithoutClinicalTurnV1`; a matching newly selected approval is required. Existing native report/MAC formats and independent finality readers are unchanged. Private-input calls never supply transport packets to the unconditional-public queue. Both holds remain until independent finality/settlement owners prove their own purposes. Complete no-stop/all-ASR and real acceptance remain open; this is not default activation.
