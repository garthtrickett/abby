# Voice validation, 5 November 2026

This checkpoint refreshes synthetic speech measurements and audits the automated
phone harness against merged main `5d6e7fa5`. It does not select a new voice
profile, enable conversation or authorize clinic traffic.

## Fresh synthesis

The [aggregate report](../eval/baselines/synthetic-synthesis-refresh-20261105-v1.json)
records two predeclared profiles. Each used the unchanged two-message corpus,
twenty repeats per message, concurrency four and `coral`. First-chunk, later-step
and utterance bounds stayed at 5,000, 2,000 and 20,000 ms. The original gate
requires every job to queue successfully, first-chunk p95 at most 3,500 ms,
every first chunk at most 5,000 ms and utterance p95 at most 6,000 ms.

| Profile | Queued | Primary/fallback selected | First queued chunk p95 | Utterance p95 | Gate |
| --- | --- | --- | --- | --- | --- |
| `gpt-4o-mini-tts` / `tts-1`, primary bound 1,500 ms | 39/40 | 37/3 | 3,143 ms | 3,307 ms | Fail: one uncertain job |
| `tts-1` / `tts-1`, primary bound 2,500 ms | 40/40 | 40/0 | 1,813 ms | 2,420 ms | Pass |

The uncertain job selected the primary, queued 185 chunks and failed before
completion. Its first chunk was at 901 ms and its total time was 3,573 ms.
The existing report does not distinguish a provider stream failure, malformed
tail or later-step timeout; an exact cause is unproven. It must not switch to a
second voice after partial output or be removed from the denominator. The three
fallback selections completed successfully. The p95 values describe successful
queue operations, not audible carrier latency or comprehension. These cohorts
were not rerun to replace the failure with a pass.

The passing candidate is an experiment, not a runtime configuration change.
The [official Speech API guide](https://developers.openai.com/api/docs/guides/text-to-speech)
also documents retirement of these Speech API models on 6 January 2027. Abby's
existing optional Realtime synthesis adapter is a separate transport and needs
its own exact-profile qualification; this checkpoint performs no migration.
No speech-recognition, Krisp, representative-call or clinic gate is closed here.

## Automated phone coverage

The [caller guide](AUTOMATED_CARRIER_REHEARSAL.md) distinguishes the basic caller
from the richer probe. Saved exact-call journals and provider-restoration receipts
were reread for the three successful restricted carrier scenarios below.

| Requirement | Existing automated evidence | Remaining limit |
| --- | --- | --- |
| Greeting and two-way dialogue | Basic caller checks four ordered signed speech callbacks and exact caller completion. The richer probe additionally checks three target turns, four completed playbacks and the matching completed inbound leg. A restricted real call passed on 3 November, main `0aa4457c`. | Fixed diagnostic phrases; no general receptionist conversation, booking flow or recognition-quality qualification. |
| Interruption | Restricted target plus probe require two turns, two completed playbacks, one interruption and one acknowledged clear. A fresh real call passed on main `6b0ce9fe`. The earlier one-playback attempt remains unverified. | Does not measure audible interruption-to-silence p95, stale audio at the listener or representative accents/noise. |
| Hangup | Richer dialogue/interruption probes require clean target stop, caller and inbound completion, and a complete empty child-leg readback. The selected real calls passed. | Call-specific observation, not an account-wide inventory or a repeated complete suite on the corrective source. |
| Fallback ringing | Probe requires keypad fallback, a signed ringing event for the exact child, and independent complete child-leg readback under the matching inbound parent. A real call passed on main `0aa4457c`. | Ringing does not prove a staff answer, conversation, successful handoff or all provider-failure routes. |

The basic caller alone still reports interruption and fallback as not run.
Local gateway, callback, target and playback tests exercise signed routing,
identity mismatch, duplicate/out-of-order events, incomplete provider pages,
cleanup, unknown creates and denied evidence. Injected speech and loopback
traffic supply protocol evidence, not a real-carrier acoustic pass.

The successful interruption source and current base have identical `src/testing`
and probe/target runner sources. The older dialogue/fallback source differs in
the later caller-pause correction, so the selected passes remain separately
scoped historical evidence. No new call was placed during this audit.

## Corrective work

The probe originally checked cancellation at the start of its final provider
readback loop, but not after awaited reads. Cancellation during a matching target
or child read could therefore still produce a qualified pass. The read-only
[observation coordinator](../src/testing/twilio-rehearsal-carrier-observation.ts)
now checks cancellation before reads, after each read and before returning.
The existing fifteen-attempt/twenty-second observation bounds remain unchanged;
no call creation, retry policy, carrier gate or production voice setting changes.

[Regression cases](../test/voice/carrier-probe-scenarios.test.ts) cover cancellation
before reads, during either read for all three scenarios, cancellation during a
retry wait, successful matching observations, transient failure recovery,
incomplete pages, exhausted bounds and unavailable reads. Affected strict
compilation and the compiled CLI plus focused voice regressions passed 51/51,
with no skips or cancellations. This is an affected graph, not a whole-project
serving build. A future carrier rehearsal on the corrective source remains a
separate observation, not a result invented from these tests.

## Case-level speech and listener boundary, 6 November 2026

A separate patient-free analysis rehashed the private original reports for four
predeclared Nova-3 noisy-speech profiles: public vocabulary alone, RNNoise,
DeepFilterNet3 and fixed FFT denoising. Each used the same six cases three times.
Every profile failed the unchanged critical-term/WER gate. The table gives the
three verdicts for each fixed case, without exposing recognized text or audio.

| Profile | NS-004 availability date | NS-005 booking request | NS-006 urgent language |
| --- | --- | --- | --- |
| Vocabulary alone | mismatch ×3 | critical ×3 | critical ×3 |
| RNNoise | mismatch ×3 | mismatch ×3 | critical ×3 |
| DeepFilterNet3 | mismatch ×3 | mismatch ×3 | critical ×3 |
| Fixed FFT | mismatch ×3 | critical ×3 | critical ×3 |

NS-006 remained critical in all twelve attempts and NS-004 mismatched in all
twelve. Exact token inspection found the pinned urgent term `chest` absent in all
twelve NS-006 transcripts; `pain` was absent in nine. NS-005 changed
classification across the separate cohorts. These results
identify persistent fixture-level failures; they do not rank filters causally or
substitute for the selected Krisp experiment. No new provider request was made
for this analysis, no gate was relaxed and no profile was promoted. The private
case-only receipt is `/home/gust/.local/state/abby-current-plan-20261106/speech-case-analysis-v1.json`.

The carrier probe's Twilio marks establish transport playback completion, but
cannot measure what the independent caller actually heard after interruption.
Twilio's [unidirectional Media Streams](https://www.twilio.com/docs/voice/twiml/stream)
can fork both tracks from the scripted caller leg to a signed WSS listener.
On that leg, `outbound_track` is the scripted caller's speech sent to Abby;
`inbound_track` is Abby's speech heard by the scripted caller. The
[message format](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
provides per-track media timestamps and 8 kHz μ-law payloads. A prospective
restricted test can correlate the scripted caller's second utterance onset on
`outbound_track` with the end of Abby speech on `inbound_track`, using only
fixed public test phrases and an in-memory bounded window. It must authenticate
the exact call/stream, reject missing or disordered media, and report an unknown
result when Abby's speech cannot be isolated from other audio on the inbound
track. No patient audio, raw payload or transcript belongs in the journal
or repository. This is a test design, not a measured audible-silence result or
permission to claim the representative-call gate.
