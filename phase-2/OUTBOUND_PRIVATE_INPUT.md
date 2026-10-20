# Prepared outbound voice sessions and private input

Status: locally qualified transport prerequisite under [EXECUTION_ORDER.md](EXECUTION_ORDER.md),20October2026. This patch has not yet been published or cloud-qualified. Its base main eeda411 independently passed all four cloud jobs. The separate original-patient clinical prerequisite is PR568; its publication/qualification is tracked independently.

## Interface and ownership

The optional Abby outbound conversation factory accepts exactly one selection: its existing synchronous `session` callback, or asynchronous `prepareSession`. Preparation receives one call's volatile ledger, actual provider key/public clinic number/scope/profile, fresh session ID, authenticated original routing context and existing ingress cancellation. It returns one synchronous session factory and optional private keypad input together. The shared reception/controller factory stays synchronous; clinic/provider names do not branch inside it.

The current outgoing profile must be approved before preparation and remain current after the await and before speech/session construction. The existing five-second signed-wire startup deadline remains unchanged. Cancellation ends observation even when a preparer ignores its signal; a late returned input is stopped without constructing a session. Malformed/extra-field results and construction/ownership failures refuse rather than falling back to the old callback. Returned factory function identity is captured before later use. No private lookup map, queue, schema or automatic retry is added.

Each invocation owns its own ledger, session ID, factory and input. The actual transport claims private input for that exact call/session before admission, starts it after the real session attaches, and uses its existing private-media discard, digit routing and fresh quiet-drain protections. Shutdown retires owned input. A different or already claimed input cannot be borrowed by another call. The shared session owner still checks the returned VoiceSession's actual call/session/scope binding.

The original routing context is not an incoming event, patient proof or clinic action grant. The later clinical module must independently approve/reread that context and use the normal registered-channel verification, patient/action permission, exact target, played SAM, native review and one-shot action owners. No raw private code belongs in transcription, model input, ordinary keypad commands or durable standalone state.

## Completed local evidence

| Qualification | Actual result and scope |
| --- | --- |
| Signed prepared and legacy conversation | Initial13 controls passed; expanded15 controls passed `work1792497126680`, including actual private wire/audio suppression, wrong ownership, changed approval, malformed/extra output, factory failure, disconnect, real startup deadline and two calls using one selected factory. These use a synthetic private-input adapter and grant no patient proof. |
| Broader source preservation before the resumption extension | `work1792497657205`:59 passed, zero failures/cancellations/skips,39s, peak169,340,928B/512MiB, heap384MiB. Includes existing incoming keypad verification, signed ingress and actual speech-stop producer preservation. |
| Complete strict and serving build before the SQL fixture extension | `work1792497126797`: `npm run typecheck && npm run build:voice-tests` passed3m51s;672 artifacts, peak1,608,101,888B/2GiB, heap1536MiB. Production implementation is unchanged by the later fixture extension. The frozen runner's copied clinical-owner display string does not change its actual command/root/input scope. |
| Current serving-only build | `work1792497657318`: `npm run build:voice-tests` passed1m19s,673 artifacts, peak1,061,810,176B/2GiB, heap1536MiB. This emits the prepared conversation fixture; it is not relabeled another whole-project typecheck. |
| Affected strict types before the resumption extension | `work1792497868056`: prepared implementation, signed fixtures and new SQL fixture passed their inherited strict project,38s, peak501,514,240B/1GiB, heap768MiB. |
| Actual emitted SQL/exclusion/privacy | `work1792497768176`:2/2 passed, zero failures/cancellations/skips,12s including setup/cleanup. Accepted input and cancelled preparation both retain the real PostgreSQL one-use session barrier across a second server. Actual private digit delivery stays outside transcription/intent; all application columns and an unfiltered logical backup exclude the input, original routing context, patient/recipient/native references and actual transport secrets. Node101,023,744B/1GiB plus externalDB82,288,640B/512MiB. Owned containers/slice were cleaned. |

A later stronger signed-wire witness, `work1792498170418`, passes all9 prepared-input controls, zero skips,7s, peak91,324,416B/512MiB. It follows private digit acceptance through the actual500ms quiet drain into an ordinary transcribed/intent-handled caller turn and another played-reply marker, while the private digits remain absent. The final combined type/source gate must include this test-only extension.

All jobs used CPU100% per scope, Swap0 and no OOM/high/max events. Actual source/dependency/artifact pins were checked; the SQL fixture uses unique synthetic identities rather than short/shared public sample values. The earlier serving-only fixture build remains separate evidence. Raw logs and private manifests are retained outside the repository. The final current source/type/build qualification and exact SQL equivalence are recorded below. Facts/scenario/naming/source guards and this patch's exact-head cloud checks remain required before landing.

## Remaining clinical and runtime work

These are transport/session-preparation witnesses, not a complete signed original-patient clinical journey. Connect the real outgoing clinical flow and private keypad, then qualify the actual signed greeting, spoken workflow selection, registered-channel delivery, private code entry, original-only menus, played confirmation, reviewed native action and late-authority/target denials. Follow-up booking and exact cancellation retain their separate normal owners and evidence.

Private audio is deliberately discarded during secret collection. That cannot establish that no stop request was spoken. Complete no-stop/all-ASR reporting remains unfinished; actual OpenAI quality remains uncertain and is not promoted. Call closure or a successful private-input callback cannot release contact/call holds or attest provider finality.

The prepared-session contract supports composition of the existing Abby runtime; it does not implement Vapi. A future adapter still needs authenticated correlation, suitable private-input and played-confirmation evidence, and the same independent clinic owners. Unsupported evidence must refuse. Real clinic/provider/source/restore/acoustic acceptance, live activation, approved gap13 and the full thirteen-gap execution order remain open.


## Final current local qualification

`work1792500533531` passes the complete current59-control cohort, zero failures/cancellations/skips,42s, peak170,577,920B/512MiB, heap384MiB. This includes all9 strengthened signed input/ordinary-resumption controls and existing incoming keypad, legacy conversation, ingress and stop-producer preservation.

`work1792500533412` passes full `npm run typecheck && npm run build:voice-tests` in3m59s with673 artifacts, peak1,629,650,944B/2GiB, heap1536MiB. CPU100% each, Swap0, no OOM/high/max events. Every final runtime/fixture artifact is byte-identical to the set used by actual emitted SQL `work1792497768176` (2/2 passing, including two-server permanent exclusion and complete privacy). The SQL driver, helper and production input bytes are unchanged; only documentation and the separately requalified signed-resumption test differ. This is exact evidence reuse, not a newly executed SQL run. Frozen prior evidence remains intact. Own cloud qualification still follows.
