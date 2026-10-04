# Standalone Cliniko cancellation implementation

**Status:** local text implementation of D-16, not a clinic activation. E2E-272 composes the real agent gateway, SAM, email-proof verifier, cancellation host, review writer/recovery reader and appointment writer. Email delivery, patient/action permission, fee selection and provider traffic are synthetic in this proof. The production runner still advertises cancellation as unavailable. The nine-step objective remains open.

## Contract

1. Bind one fresh phone candidate and registered Cliniko email to the live call/session, clinic policy and cancellation operation. Verify the email code outside model context; issue only a transient proof.
2. Before every protected use of an email proof, recheck that candidate, current contact, patient/action permission, policy and original challenge expiry. Contact control alone never provides self/proxy/minor permission. Refresh cannot send another code or mint new proof; revocation, verifier close and process loss lose authority.
3. The trusted clinic authority selects the exact target, provider location/credential, cancellation reason and approved fee terms. Present those terms and target through SAM. Only a separately accepted caller affirmation after played details may dispatch the host effect.
4. Recheck the confirmed request against current SAM, call/session lease, proof, clinic policy/terms and emergency stop. Save one exact version-2 recall request in Cliniko and require exact acknowledgment. Recheck again before entering the cancellation writer.
5. The writer re-reads the exact active appointment and reserves provider budget. A final trusted authorization callback then runs after those edge waits and immediately before PATCH. It prevents authority changes while the edge was waiting from sending a stale request. This is a last check, not atomic exclusion of external writes.
6. Send at most one cancellation PATCH. A clear 204 plus an exact cancelled read-back permits a best-effort committed receipt. Missing/failed acknowledgment, changed target/read-back, stop/disconnect or deadline remains unresolved. No automatic retry or compensation exists.
7. After a lost clinical reply, reconciliation always returns `stillUnknown`: matching later mutable state does not identify the original writer or prove fee/notification effects. The provider-owned recall remains pending. No automatic recall closure, staff assignment, notification or human acknowledgment is invented.

An unknown recall acknowledgment never sends the appointment mutation. Existing local attempts are consumed; recovery readers observe provider work without issuing a new request. Full process-loss and no-local-patient-storage obligations remain those of C-LOCAL-56/57/58 plus operation-specific evidence; a new host or empty provider scan cannot authorize replay.

## Modules and function relationships

| Interface | Input → output | Implementation calls |
| --- | --- | --- |
| `EmailPatientAuthority.start` / `answer` / `attest` | cancellation operation / code / bound token request → generic start / opaque token / patient/action authority | registered contact, unique index candidate, clinic permission, current policy, aggregate issue/answer budget, intentional email delivery; all challenge/grant state transient |
| `EmailPatientAuthority.revalidate` | bound scope/call/session/patient/action/policy → boolean | original attested contact/expiry, fresh candidate/contact/permission/policy; bounded and abortable; no new token or email |
| `TransientPatientProofHost.verifyOperation` | scoped opaque verification reference, operation, time → `VerifiedPatient` or `HostReadFailure` | current policy, optional source revalidation, expiry and revoke/dispose checks; legacy owning-host verifier contracts continue using their own versioned permission source |
| `ClinikoAppointmentChangeGuard.resolve` | scoped target selection, proposal/commit phase, abort → prepared request/provider target or typed read failure | proof verification, trusted current appointment/fee authority, provider-selection validation, captured/current policy; proposal additionally observes the exact active provider target |
| `ClinikoAppointmentChangeGuard.authorize` | private prepared target, SAM mutation, current time, abort → boolean | active session/lease, played presentation, dispatched action/possibly-sent effect, write stop, current policy, fresh resolve, exact digest/provider/terms checks |
| `ClinikoAppointmentChangeGuard.mayObserve` / `dispose` | existing embedded prepared mutation/abort → current observation permission; none → closed guard/proof | legacy embedded uncertainty/session/proof checks; standalone cancellation never uses this to mint a receipt |
| `ClinikoCancellationHost.resolveAppointmentChange` | cancellation proposal query → approved action or typed read failure | shared guard; captures one private prepared request; booking and rescheduling remain unavailable |
| `ClinikoCancellationHost.write` | confirmed SAM mutation, time, abort → rejected/uncertain/committed `HostWriteReceipt` | exact binding and single-attempt claim → `ClinikoReviewedSend.run` → shared guard before/after acknowledged review → cancellation writer with final guard callback |
| `ClinikoCancellationWriter.cancelOnce` | exact target/reason, abort, optional trusted final callback → inspected outcome or typed provider failure | exact active target GET → request budget → final callback → one PATCH → exact cancelled GET; failed/held callback cannot send late |
| `ClinikoCancellationHost.reconcile` | mutation → `stillUnknown` | no provider observation can be promoted to exact writer evidence; no resend |
| `ClinikoCancellationHost.openTask` / `reconcileTask` | generic staff work → rejected / unknown | no patient task storage or delivery claim; the pre-send recall is distinct from a general handoff receipt |
| `ClinikoCancellationHost.dispose` | none → closed owner | abort review/writer work, close shared guard/proof, clear prepared request; late results cannot confirm or restore authority |

The shared guard extracts existing call/proof/confirmation checks from the embedded Cliniko appointment-change host, reducing that host's size without changing its current behavior. The standalone host owns its different review and reconciliation contract; the core has no Cliniko import, and an owning buyer retains its separate atomic diary adapter. Host authority and final-send callbacks are supplied by trusted composition code, never by the agent/model proposal schema.

## Evidence and activation gaps

- E2E-272: actual text gateway/SAM journey, registered email code, played target/fee terms, caller affirmation, required review-before-PATCH, exact successful inspection, replay refusal and truthful unresolved loss. It also covers changes during the final provider read, a held/aborted final authority callback and closing during a held clinical response.
- E2E-273: already-issued proof loses access after contact/phone/candidate/permission/policy changes, source expiry or verifier close. Revocation interrupts a held refresh, and its late success cannot restore proof or resend a code.
- The PostgreSQL journey uses the real aggregate issue/answer budget and scans actual rows and a disposable backup for proof, code, provider notes/marker, private caller data, call/session/action keys and appointment time. Patient index and durable calls remain empty. Synthetic provider records intentionally retain the pending request; no production patient store is introduced. Real SIGKILL tests terminate the actual text owner before, during and after its cancellation; fresh workers receive only account/clinic/type configuration and discover the pending review, while parent-side request counts prove they attempt no provider mutation. Database/backup/output scans stay clear.

These are local engineering proofs, not actual email delivery or live cancellation evidence. Remaining gates: human Cliniko report/notes witness and accepted clinic staff process; production verification and patient/action policy source; approved fee/cancellation/notification rules; clinic-scoped caller command and runner wiring; real provider lifecycle; process-loss/race/stop proofs for that final composition; source-matched speech and eventual carrier proof. Raw setting changes must continue to leave current standalone cancellation unavailable.

The local host refuses captured Abby notification directives until a supported notification contract is supplied. Its generic staff methods reject handoff instead of relabelling the saved pre-send review as staff receipt. Production must supply the approved manual review route and truthful caller wording before any patient-specific action is enabled.
