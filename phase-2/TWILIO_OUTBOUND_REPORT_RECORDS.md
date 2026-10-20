# Authenticated native outbound report records

This foundation retains producer evidence in a dedicated clinic-owned Cliniko family and recovers it from bounded native history. It provides canonical signed-content handling, exact original-send matching, current independent permissions and a permanent one-use report action. The actual Twilio speech/stop producer and its automatic recovery composition remain subsequent engineering.

## Evidence and authority

`TwilioOutboundReportAuthentication` captures one provider binding and a32-byte producer/verifier key. Its domain-separated HMAC covers every canonical record field, including original native attempt digest, intended patient/scope/account, actual dialled number, provider call identity, contact assertion and times. The immutable `authenticationBinding()` identifies the actual selected key/provider combination to independent current read/write/producer/history grants. The raw key stays inside trusted composition. Changing this key selection does not create a new permanent-action namespace.

The record action is the report UUID allocated before carrier dispatch in the authenticated original context. It differs from the consumed conversation/session action. Matching uses the original SEND digest and exact original native reference, account, intended subject/scope and dialled number; current mutable notes cannot silently replace that anchor. Intended patient/routing context supplies no verified patient or clinical permission.

A positive `stopRequested` observation may carry `terminal: null` so restrictive evidence can be retained while a call is still active. `completeNoStop` refuses without terminal evidence. HMAC validation authenticates the captured assertion; current producer/source/retention/restore approval and actual complete provider/speech coverage remain necessary for its later use. A known stop and proof that no stop occurred have different evidence requirements.

The canonical bounded native note stores no transcript, audio, model summary or new call permission. Changed fields, malformed encodings, unknown versions, wrong keys and invalid time order refuse. Cliniko note editing, deletion and retention remain possible: the MAC detects content changes; missing/conflicting evidence remains unavailable.

## Native retention and recovery

`ClinikoTwilioOutboundReportRecords` uses the existing shared native transport with separate `outboundProviderReportRecallTypeId` and `providerReportPolicyDigest` configuration. Broad and decoded private grants are independent, and every query exposes the selected authentication binding. Retention also needs the original context, current producer admission, the shared account request budget and the permanent opaque SQL exclusion. Exact native acknowledgement establishes retained evidence. A lost/unobserved acknowledgement remains uncertain; its report action cannot be replayed. The raw number, provider call identity, original digest, signature, key and note never enter local SQL.

`ClinikoTwilioOutboundReportHistory.findForOriginal` includes closed/archived records, reads the complete bounded patient history, independently rereads authenticated records, and rescans the complete history before returning a selected report. It preserves the existing500-total/50-selected history bounds and physical account-wide180-request limit. Duplicate actions, conflicting origin, edited signatures, changing scans, malformed or oversized histories and withdrawn broad/decoded/current grants refuse. An explicitly malformed clock cannot fall back to wall time; backwards time across a wait refuses. Absence never resets an action or permits a new call.

The configured verifier/source must cover the selected native family. Unknown historical keys or producer/profile bindings remain unavailable. Cross-version key retention, migration and a reviewed multi-verifier composition need their own qualification; no automatic key registry or permissive fallback is supplied.

## Qualification and continuation

[Execution progress](EXECUTION_PROGRESS.md) records actual work IDs, results and remaining cloud checks. Current qualification passes56 source controls, full inherited strict TypeScript/655 emitted artifacts, final focused strict checking of the test-only bounded-canary correction, and eight actual emitted PostgreSQL cases without skips. New-head cloud qualification remains required. Source controls cover both contact forms, every signed-field mutation, captured keys/methods, original-send mismatches, native read/write/producer denials, closed/archived discovery, duplicate/conflicting/changing histories, and malformed/backwards time. Actual emitted PostgreSQL cases cover independent concurrent connections, acknowledged and lost/unobserved writes, fresh native-history recovery, edited MACs, quota/current denial, a positive stop before closure and complete no-stop data. All-table scans include every byte of longer notes in bounded batches; unfiltered backups also check the original whole note and private canaries. No scanner, deadline, request quota or permission is relaxed.

```sh
npm run typecheck
npm run build:voice-tests
node --test --test-concurrency=2 test/cliniko/twilio-outbound-report.test.ts test/cliniko/twilio-outbound-report-records.test.ts test/cliniko/twilio-outbound-report-history.test.ts test/cliniko/outbound-contact-outcome.test.ts test/cliniko/outbound-contact-outcome-records.test.ts
bash scripts/with-postgres.sh bash -c 'npm run db:migrate && ABBY_LEDGER=postgres node --test --test-concurrency=1 test/storage/postgres-twilio-outbound-report.test.ts'
```

Continue with the actual authenticated speech/stop producer, durable original-context recovery and number-wide suppression through the existing native stop owner. Complete final provider/contact/speech reporting must establish all-call and shutdown-tail coverage before any terminal/contact settlement adapter can release held allocations. The record APIs expose no terminal/settlement port. Independent original-patient verification/exact clinical handoff, default/live wiring, approved gap13 and real clinic/provider/source/restore/acoustic acceptance remain open. No actual provider/clinic traffic, credential activation or deployment follows from this foundation.

The Karen reference remains `/home/gust/code/karen-website-dev`. Consult its transport and recovery lessons while preserving Abby's native ownership, privacy and independent authority contracts.

## Shared-database key-canary refinement

The first published head's full cloud PostgreSQL cohort exposed an alias between its fixed synthetic MAC-key canary and a legitimate public speech configuration hash. The exact failure was reproduced with a valid public policy already present. Actual SQL cases now use distinct32-byte cryptographic keys and keep the complete real key canary; codec fixtures retain their deterministic default. Nine emitted SQL cases pass beside that public policy, including a positive control proving that a genuinely injected private key is detected by the unchanged all-column scanner and unfiltered backup. Only the explicit injection is removed afterward; the public hash remains. Focused strict checking passes and all655 serving artifacts remain unchanged. See EXECUTION_PROGRESS.md for the failing/reproduced/corrected evidence. Revised exact-head cloud checks remain required.
