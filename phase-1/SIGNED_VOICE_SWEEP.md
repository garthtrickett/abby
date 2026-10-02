# Signed synthetic voice sweep

**Source revision tested:** `d9479858321b1a2c370ca7fa1238146872506718` on 2026-10-02. The tracked run `Abby broad signed voice PostgreSQL sweep with bundle` executed `npm run test:signed-voice:postgres` against a disposable PostgreSQL server. The command built the clinic-admin browser fixture, migrated the database, and ran 21 voice and composition files with four Node workers. **77 tests passed, zero failed, zero skipped** in 4m15s. The focused E2E-215 retry with the bundle built passed first. `bash -n scripts/probe-signed-voice-postgres.sh` and `git diff --check` passed.

| Boundary | Scenario evidence in the sweep | Test target |
| --- | --- | --- |
| Signed ingress, replay refusal, route scope, admission and call ownership | E2E-131, 135, 136, 143, 154, 155, 163, 170, 171, 172, 185 | Twilio ingress server, PostgreSQL active-call claims, standalone runner and route tests |
| Keypad availability, speech fallback and uncertain transcript clarification | E2E-138–140, 151, 153, 196, 205 | Standalone server and isolated runner |
| Signed clear-turn classification, in-flight correction and queued-answer interruption | E2E-236–239 | Isolated standalone runner with a synthetic clear-final transcription port |
| Cliniko read faults, policy changes, concurrency and privacy | E2E-173–176, 190, 193, 198–200, 207–210, 212, 215 | Signed standalone calls, admin-to-voice and eight-call budget fixtures |
| Disconnect, database loss and process restart | E2E-169, 176, 177, 197, 213, 234 | Signed server and separate standalone runner processes |
| Approved knowledge, model interruption, urgent wording and cross-mode authorization | E2E-004, 222, 223, 232, 240–243 | Signed embedded reference host and strict standalone versus embedded compositions |
| Appointment-proof boundary | E2E-202–203, 224–225 | Transient standalone composition and signed local transport with a synthetic verifier |

The command uses synthetic patient-free data and local signed HTTP/WebSocket traffic. Some rows exercise an isolated child running the actual standalone server; others exercise the same voice and ingress modules inside a local server or an authorized reference host. The table does not treat the latter as a production standalone route. Strict standalone still has no approved knowledge-authoring path or live patient-specific appointment method. Its normal Realtime transcripts remain untrusted because the A3 speech gate fails; clear-turn cases inject an isolated synthetic transcript. E2E-176 passed in this run, but prior intermittent 1006-versus-1011 closes remain unexplained. No result here proves real Twilio audio, fallback ringing, live transcription quality, clinic-approved wording or a buyer monolith integration.
