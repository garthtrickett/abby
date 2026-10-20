# Optional Twilio outbound HTTP and media ingress

The explicit outbound profile can now enter the existing Node HTTP/WebSocket server through its own authenticated router. Inbound and outbound share the media-socket module for ordering, bounded buffering, duplicate/active ownership, start deadlines and shutdown. They keep distinct call types and admission interfaces. Existing inbound construction remains compatible; no outbound listener, runtime or clinic is selected by default.

## Original context and one conversation

The new transport binding and sealed launch payload are version2. A separate random `sessionActionRef` is allocated before the single carrier POST, alongside the distinct future `reportActionRef`. Both remain in encrypted provider-owned context. Native Cliniko possible-attempt versions1–4 and their digests/limits are unchanged. Old sealed launch payloads without a session ID, or an ID aliased to the report action, refuse. They cannot acquire a fresh ID during recovery. Changed runtime bindings cannot adopt earlier attempts.

Answer and status routes validate the exact configured signed URL/body, account, outbound direction, root call, From/To and encrypted original context. The original ten-minute answer window and180-second stream-start credential window remain. WSS upgrade/start authentication also requires the supported single inbound track, mono8kHz mu-law profile before owner construction. The same format predicate serves the actual media decoder. Routing paths are distinct and cannot shadow inbound, Stripe or operational endpoints.

The authenticated context supplies a private original send, not original-patient verification. It never becomes `AuthenticatedInboundCall`, a caller-ID patient clue or a clinical capability. Only the private outbound voice factory receives it after independent current clinic/source/producer/restore admission.

A permanent opaque SQL effect exclusion binds the selected provider/settings and the original preallocated session ID. Two servers, cold restart and actual process loss cannot construct a second conversation for the same sealed session. The module rechecks independent admission after the actual storage wait and immediately before invoking the voice factory, then checks currentness again when it returns. A refused/lost owner leaves the consumed session exclusion conservative. No TTL, replay, fallback or reset is added. The report action remains unconsumed.

SQL retains only existing permitted opaque effect metadata. There is no new schema, private call map, callback ciphertext, original note/digest, patient record, phone hash, transcript or local report journal. Existing call/contact capacity and native outcome owners keep their separate responsibilities. A signed completed progress request is only a historical fact; it does not release either hold or attest final speech/no-stop/all-call truth.

## Construction and limits

`TwilioOutboundIngress` takes the selected concrete runtime, independent async/current authority, an opaque session-effect factory and a typed outbound voice factory. Optional progress observation receives authenticated historical facts only. Passing the router as `createTwilioIngressServer({ outbound, ... })` attaches the routes. The constructor starts no listener, carrier request, native write or consumer. The deploying host must supply actual approved authority and voice/report composition; these ports alone do not qualify those implementations.

Owned HTTP bodies are bounded to16KiB. The whole request/admission has an explicit1–10,000ms deadline, default5,000ms, including ignored-abort authority. Shared media handling retains the5-second start limit,16KiB message limit,64 outstanding receives and512KiB send buffer limit. Shutdown closes sockets and releases optional active leases. Private context is frozen before crossing authority/factory interfaces and never logged. The independent workflow owners still check patient verification, exact appointment, played confirmation and current clinical rights.

This is the Twilio/Abby transport implementation at the existing replaceable runtime seam. A later Vapi implementation remains separate and requires its own event/conversation/delivery qualification. No workflow owner branches on provider names.

## Qualification and remaining work

The initial extraction's11 inbound controls and first67 signed transport controls passed. The refined source cohort passed119/119, zero failures/cancellations/skips, as1792464717394; after shared test-driver extraction it passed again as1792465324842. Full strict TypeScript and the required643-artifact voice build passed1792464718840 at02:56:13.498938UTC,4m14s, peak1,583,665,152B/2GiB CPU100%, heap1536MiB, Swap0/allOOMhighmax0. The new SQL/driver files inherited the original strict settings through1792465323419,493,621,248B/1GiB; serving source/artifacts remained unchanged.

Migration and this actual emitted/native180 PostgreSQL cohort passed24/24, zero failures/cancellations/skips, as1792465425606, natural terminal03:05:17.926750UTC:

```sh
bash scripts/with-postgres.sh bash -c 'npm run db:migrate && ABBY_LEDGER=postgres node --test --test-concurrency=4 test/storage/postgres-outbound-twilio-ingress.test.ts test/storage/postgres-outbound-twilio.test.ts test/storage/postgres-outbound-contact-lifecycle.test.ts test/storage/postgres-outbound-runtime.test.ts'
```

Three new cases use the emitted HTTP server/router/decoder, actual native180 launch owner and actual SQL exclusion. They cover simultaneous independent servers plus cold replay, current permission revoked during a real advisory-lock wait, and a full emitted ingress process SIGKILL after the exclusion committed and before the voice factory returned. Cold authenticated recovery refuses another owner; both native call/contact holds stay held, the report ID stays unconsumed and the carrier POST count stays one. Empty child directories/output, all-app-table scans and an unfiltered native PostgreSQL17 backup exclude private context. The other21 carrier/contact/interchangeability cases remain green. Node peak413,786,112B/1GiB plus DB115,040,256B/512MiB, CPU100%each, heap768MiB, Swap0/allOOMhighmax0. All1905 source/643 artifact pins, paired wait and owned scope/slice/container cleanup were verified.

Final authenticated legacy-without-session and aliased-session/report envelopes are refused even with valid encryption and provider signatures. The complete source cohort passed121/121 as1792465672520, zero failed/cancelled/skipped,32.9s,152,645,632B/512MiB CPU100%, heap384MiB, Swap0/OOM0. Its current test-only strict graph passed1792465673932,44s,483,737,600B/1GiB, with unchanged serving source/artifacts; no unchanged build or SQL cohort was rerun. Focused evidence does not qualify the complete combined cloud graph.

Actual outbound conversation, immutable complete final contact/speech reporting and independently verified original-patient/exact clinical callback still need implementation. Default service wiring, current deploying-host source/grants/restore, real provider/public-route/acoustic/clinic acceptance and activation remain separate gates. No real provider or clinic traffic, credential provisioning, deployment or reference deletion was performed. Consult the preserved Karen source at `/home/gust/code/karen-website-dev` when useful; do not copy private local call journals or fail-open consent/DNC.


## Startup wire queue refinement

A real prepublication counterexample1792466287502 showed the inherited64-message check ran only after call creation: an80-frame backlog could be read and acknowledged while async startup was blocked. The shared module now counts admission at message arrival until startup processing or asynchronous delivery finishes. The same64-message limit applies before authentication/storage/construction completes, and overflow aborts/closes the stream before enqueueing another promise. Fixed focused1792466328440 passes. Earlier121/643/24 results above are pre-refinement; final current whole source/build/SQL evidence follows in the execution ledger.


## Final corrected startup qualification

After the reproduced startup-backlog defect was corrected, the complete source cohort passed122/122 as1792466547518, zero failed/cancelled/skipped,32.4s/146,345,984B under512MiB CPU100%, heap384MiB, Swap0/OOM0. Full strict TypeScript and the required643-artifact build1792466549000 passed at03:26:34.311424UTC,4m05s,1,599,705,088B/2GiB CPU100%, heap1536MiB, Swap0/allOOMhighmax0. Seven additional real signed voice playback, silence, model-stop and correction controls passed1792466860290 in8.65s/152,514,560B under512MiB CPU100%, heap384MiB, Swap0/OOM0.

The same complete emitted/native180 four-file SQL cohort was requalified as1792466840071:24/24, zero failed/cancelled/skipped, natural terminal03:28:41.748356UTC. Node430,809,088B/1GiB plus DB110,190,592B/512MiB CPU100%each, heap768MiB, Swap0/allOOMhighmax0. All1906 current source/643 artifact hashes, paired waits and owned Node/DB scope/slice/container cleanup were independently verified. The earlier121/24 evidence remains pre-refinement; no counterexample or negative was erased. No source/assertion/deadline/concurrency limit was weakened. The existing64-wire limit now applies before async startup as well as later semantic delivery.

Current local engineering qualification is complete for this optional ingress patch, based on qualified main88dd3b0; exact new PR-head cloud qualification/review still follows. The automatically triggered main39363817486 remains separately monitored and no result is inferred. Actual conversation/final provider/contact/speech reporting, independently verified clinical handoff and approved gap13 remain next, with all real acceptance/activation gates distinct.

## Exact cloud closure — 20 October 2026

PR560 exact d1ff027 passed both push39364786381 and pull-request39364790780 graphs, all eight jobs with resolved review state. Each text graph passed4427, zero failed/cancelled,254 existing mode-only skips; each PostgreSQL graph passed5398, zero failed/cancelled, one existing C-LIVE-40 skip; each separate ordered cohort passed6. It merged04:04:49UTC as d13b98f35830a9d17513b52c9a37cbfa729c3676. The automatic new main graph is separately tracked; its result is not inferred. This closes this optional ingress patch's cloud qualification, with the actual-conversation/final-report/verified-clinical/acceptance limits above intact. The next [outgoing admission prerequisite](OUTBOUND_CALL_ADMISSION.md) has separate local evidence and requires its own exact-head cloud checks.

## Actual Abby conversation factory — 20 October 2026

The [conditional conversation factory](TWILIO_ABBY_OUTBOUND_CONVERSATION.md) now implements this ingress's explicit call-factory seam using Abby's real media/session/playback machinery and independently approved outgoing profile. The corrected combined candidate has93 source controls, full strict/652 build,27 emitted SQL/native180/caller-turn/crash/backup cases and both actual incoming financial offer-prefix journeys locally qualified. It refuses transcription results after approval loss during either physical wait. Initial48 passed its cloud checks; corrected new-head cloud checks remain required. The permanent session claim stays distinct from the report action and held allocations; actual complete provider/contact/speech reporting, original-patient verification/clinical callback and default/live acceptance remain next.
