# Conditional Abby outbound conversation

The optional `twilioAbbyOutboundConversation` factory connects the signed outbound ingress to Abby's actual media, playback and session machinery. It does not create an incoming event or use the called number to select a patient. It is explicitly provisioned; the default standalone service and CLI remain unchanged.

The provider owner keeps the called number and immutable original send context in a volatile closure. The direction-neutral entry receives only public account/call identifiers, original clinic scope, public clinic number and a pinned profile reference. The separately approved outgoing greeting is time bounded. Its fingerprint covers clinic/policy versions, voice settings/profile, approved greeting, physical host model configuration and effective media/playback options. Changed configuration, an incoming-purpose greeting, missing readiness, wrong scope and lost/expired approval refuse before speech. Current time is rechecked independently of a host source's true claim.

`ReceptionVoiceCall` owns existing full/prelocation session handoff, renewal, playback and shutdown. The incoming adapter preserves its existing constructor and shared-number intake; embedded incoming composition remains explicitly incoming. The outgoing entry has no location-choice path or incoming caller-number lookup. `TwilioConnectedCall` uses the same actual controller and lease/silence behavior for either entry. A lost outgoing approval fences new media and lease renewal. Provider speech adapters, model/session callbacks and runtime settings are captured by the explicitly configured host; physical speech input/output gates remain current throughout the call.

The actual standalone factory owns one transient `MemoryLedger`. Its session factory receives the exact original native send context privately as routing evidence, never as a verified patient. Any original-patient verification, recall/appointment target binding and clinical action require their independent owners and permissions. Disconnect disposes the rich in-memory state; no patient-bearing SQL, private digest index, ciphertext journal, transcript log or private call map is introduced.

The existing permanent SQL conversation exclusion precedes this factory and is independent of its transient ledger. A failed policy/profile binding still leaves that exclusion spent. Conversation closure or a played greeting does not spend the separate report action, release the original contact/call holds, prove no stop request, certify all possible provider calls ended, or grant a clinical action. The carrier adapter continues to return terminal `unknown` until the separate complete reporting work is implemented.

## Shared ownership

```mermaid
flowchart LR
  Incoming[Authenticated incoming call] --> Intake[Incoming routing and location choice]
  Outgoing[Authenticated original outgoing context] --> Approval[Outgoing scope and profile approval]
  Intake --> Controller[ReceptionVoiceCall]
  Approval --> Controller
  Controller --> Session[VoiceSession and media playback]
  Session --> Owners[Independent clinic action owners]
```

## Qualification

[Execution progress](EXECUTION_PROGRESS.md) records actual qualification IDs/results and any remaining cloud checks. Focused controls use the actual signed answer/WSS/start path and actual Abby conversation classes, cover greeting playback evidence, current-profile/model/media changes, private original-context linkage, grant withdrawal during a real ledger read, and independent time-bound expiry. Existing incoming admission, location choice and voice controls run beside them. The emitted PostgreSQL tests include the actual caller audio/transcription/intent/reply loop and compose the native180 owner and real shared exclusion across independent/cold servers, revoked policy during a held read, and a real emitted-process SIGKILL after greeting audio. Privacy scans include all application tables, an unfiltered PostgreSQL17 backup, and empty child directories/output. Current focused qualification passed91 source controls,27 emitted SQL cases,7 existing signed incoming controls and the actual staged incoming E2E-419 case, with full strict TypeScript and652 artifacts. New-head cloud qualification remains required; focused evidence is insufficient to declare the combined graph green.

```sh
npm run typecheck
npm run build:voice-tests
node --test --test-concurrency=2 test/voice/shared-number-voice-call.test.ts test/voice/twilio-connected-call.test.ts test/voice/outbound-voice-entry.test.ts test/voice/twilio-outbound-conversation.test.ts test/voice/twilio-outbound-ingress.test.ts test/admission/admission.test.ts test/admission/shared-number-intake.test.ts test/admission/pending-location.test.ts
bash scripts/with-postgres.sh bash -c 'npm run db:migrate && ABBY_LEDGER=postgres node --test --test-concurrency=4 test/storage/postgres-outbound-conversation.test.ts test/storage/postgres-outbound-twilio-ingress.test.ts test/storage/postgres-outbound-twilio.test.ts test/storage/postgres-outbound-contact-lifecycle.test.ts test/storage/postgres-outbound-runtime.test.ts'
```

Complete immutable provider/contact/speech reporting, automatic authenticated at-number stop recovery from that producer, independently verified original-patient/exact clinical handoff, live default wiring, approved gap13 and real clinic/provider/public-route/acoustic/source/restore acceptance remain separate work. The existing native settlement/stop owners are reused by that work. Twilio's [WebSocket messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages) distinguish stream closure from call closure and report marks after clear as well as playback; [Call status](https://www.twilio.com/docs/voice/api/call-resource) does not identify a verified patient. Neither source provides a shortcut around Abby's complete report/independent authority requirements.

Consult the preserved Karen reference at `/home/gust/code/karen-website-dev` when useful; do not copy its private local call journals, raw customer logging or fail-open consent/DNC behavior. No real provider/clinic traffic, deployment, credential activation or Karen deletion is part of this qualification.
