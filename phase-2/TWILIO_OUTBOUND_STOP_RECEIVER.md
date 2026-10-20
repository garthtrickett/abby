# Signed outbound HTTP stop receiver

`twilioOutboundStopReceiver` is an optional concrete composition for the actual Twilio ingress server. It pairs one selected runtime with `ClinikoTwilioOutboundStopRecovery`; a different provider/profile/settings selection refuses. It preserves the normal signed answer/media routes and permanent conversation-session admission. No default CLI or live listener is activated.

An explicit optional recovery hook receives the exact frozen signed request only after the existing router has authenticated it and obtained current independent ingress permission. Ordinary progress observers retain their original two arguments and do not receive raw callback bodies/signatures. Current ingress permission is rechecked after the recovery wait and before historical observation. The standalone receiver reauthenticates terminal delivery through the concrete recovery owner and independently reads the MAC-protected clinic-owned report; the status itself never establishes a stop, patient identity or complete terminal/contact truth. An optional existing progress observer runs after successful recovery handling.

| Delivery/evidence | HTTP result | Workflow effect |
| --- | --- | --- |
| Invalid signature/correlation | 403 | No recovery or conversation construction. |
| Nonterminal initiated/ringing/in-progress | 204 after current progress permission | Historical progress only; no native recovery reads. |
| Terminal delivery, report absent | 503 | No DNC write or hold release; later provider-owned redelivery may find the report. |
| Terminal delivery, authentic report says stop | 204 after an accepted or independently discovered decision | The existing clinic-approved DNC owner records unknown consent/blocked contact once using original reserved IDs. |
| Terminal delivery, authentic no-stop data | 204 delivery acknowledgement | No DNC decision, contact permission or hold release. |
| Uncertain DNC acknowledgement | 503 | Permanent action stays consumed. A cold signed delivery discovers an observed committed decision; an unobserved write cannot replay. |
| Current grant, native quota, source/history or deadline failure | 503 | No invented success or retry write; holds remain conservative. |

Terminal status selection includes completed, busy, failed, no-answer and canceled. Selecting these events is only a delivery trigger. Signed completed progress and a local conversation closing remain insufficient for complete all-call/ASR/shutdown-tail truth.

The existing ingress deadline and current-grant fences cover the entire request. All native work still shares the physical API-user180 budget and the recovery owner's bounded operation allowance. No detached job, private local callback/call/phone queue, retry timer, native ID reallocation or carrier launch is introduced. Provider-owned redelivery is possible, not a guarantee of eventual recovery; unavailable or lost producer evidence remains held for separate authorized reconciliation. Known exact native ACK truth is not erased by a later HTTP observer or ingress failure.

An intended patient's native record remains private routing context; the responder at a shared number is not treated as the verified patient. Independent clinical subject/action grants, number-wide stop coverage, contact/capacity settlement and reconsent remain separate. The actual speech/stop producer, complete provider/contact/speech finalizer, retained historical verifier/source/restore qualification, clinic/provider acceptance and activation are unfinished. This receiver does not permit replay or upgrading of the existing one-use preterminal report.

## Qualification

Current source cases exercise actual signed loopback HTTP requests through the actual ingress server and receiver, native report authentication/history and the real restrictive owner, with synthetic native transport. Focused strict, whole serving build and actual emitted PostgreSQL results are recorded in EXECUTION_PROGRESS.md. Emitted cases include two independent servers and database connections, late report delivery, committed ACK loss, uncertain unobserved write, current-grant loss, native180 exhaustion and no-stop delivery acknowledgement. All-column chunked canaries and unfiltered backups cover actual keys/token, distinct19-digit patient ID, call/number/original digest/MAC, whole callback URL/body/signature and native report/DNC notes. These are synthetic engineering checks, not real carrier/clinic acceptance or activation.
