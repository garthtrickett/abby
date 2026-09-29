# Live synthetic evaluation baseline — 2026-09-29

All runs used patient-free synthetic fixtures, an account-provided OpenAI API key, and owner-only reports under ignored `eval/results/`. No key value or real patient content is in this file. The reports retain repeat-level proposals or transcripts for local review; this summary records only counts and configuration evidence.

| Run | Model | Corpus and repeats | Match | Mismatch | Critical | Provider failure |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Model prompt v1 baseline | `gpt-6-luna` | `model-v1`, 10 cases × 3 | 24 | 0 | 3 | 3 |
| Model prompt v2 candidate | `gpt-6-luna` | `model-v1`, 10 cases × 3 | 30 | 0 | 0 | 0 |
| Availability intent v1 baseline | `gpt-6-luna` | `availability-intent-v1`, 18 cases × 3 | 44 | 0 | 0 | 10 |
| Availability intent v2 candidate | `gpt-6-luna` | `availability-intent-v1`, 18 cases × 3 | 54 | 0 | 0 | 0 |
| Realtime transcription | `gpt-live-transcribe` | `transcription-v1`, 3 audio fixtures × 3 | 9 | 0 | 0 | 0 |
| Telephone-band transcription | `gpt-live-transcribe` | `transcription-telephony-v1`, 3 G.711-normalized fixtures × 3 | 9 | 0 | 0 | 0 |

The model baseline failed booking intent three times because the model supplied `next week` in `requestedTime`, which the typed boundary correctly rejects as lacking an absolute instant. It also proposed appointment lookup three times for a shared-phone request where patient identification must come first. `prompt-v2` explicitly leaves relative times unresolved and routes another person's appointment request to patient lookup or handoff. The unchanged corpus passed all 30 repeat-level checks with that version.

The model v2 run was repeated after the runner began loading the file named by `--prompt-version`; the second 30/30 run used that default path and the source hash below.

The availability baseline classified undated, ambiguous, and past requests as availability with unusable dates; the decoder correctly returned `intentUnavailable`. One mixed staff request also failed. `availability-intent-v2` explicitly treats those requests as unsupported, and the unchanged 18-case corpus passed all 54 checks. Both versions leave patient-specific actions and disclosure to the typed core and host verification boundary.

The transcription run used the normal `gpt-live-transcribe` adapter with three generated PCM clips paced in 20 ms frames. All nine final transcripts preserved the fixture expectations. Clean synthetic audio does not establish telephone, accent, background-noise, or real-caller performance. Its finals remain untrusted for caller actions.

The telephone-band run used the same three generated phrases after 8 kHz G.711 mu-law encode and the production media normalizer's 16 kHz decode. All nine final transcripts matched and preserved the critical terms. This tests codec and bandwidth loss with a real transcription provider; the source remains clean robotic speech, and the test has no real telephone transport, acoustic noise, varied speakers, or provider playback acknowledgment. Its finals also remain untrusted.

Configuration hashes from the local reports:

| Candidate | Prompt SHA-256 | Corpus SHA-256 | Adapter SHA-256 |
| --- | --- | --- | --- |
| Model v2 | `15c893fbdd6ce1d885682e10571b43f7985ca4438155da9d36cc563639d15272` | `a6132d8f0457ac16eb9fc65fa83e47767b3f8a2e2eb8d1d96ee0bd33064e8a5a` | `95313b44de246ce997b6c895e9cc2a686c39bf3960e2f6e73a055ec581d977f2` |
| Availability v2 | In adapter source | `b20f103bf8f8b15c286fed2018195ea63969fe3fc3ccb0e5dc97eb90a9bd9c5b` | `1dafc0bac037bda70456d3a27d67a3602d1717676982a4f85df50cba2d3d7d70` |
| Transcription | None | `2d3fabc12d13699ffecc4017d64ba9cedc91373e001529abf135a6f311357905` | `4b0f51859cb1a9fa067ee60f91a0c31c22bd6f42d77d4aefb91c1ae529e3d0f1` |
| Telephone-band transcription | None | `65645afaeeaca6c91342b8e690c184affd58e004f3438cfa0cccfdd18e3f8e1a` | `503dca334692756bef972a50ecd53c765c21aa2fb49c09ed257d3ce06414ccf4` |

The results above are synthetic, model-only or transcription-only results. Human review and the full voice-call gate are unrun, and every report says `releaseGate: unverified`. No live clinic pilot or autonomous patient action is approved by these counts.

## Speech synthesis and transcription loopback

The patient-free `speech-loop-v1` corpus sends the AI disclosure and a provisional availability notice through Abby's actual synthesis adapter, keeps 16 kHz PCM only in memory, and replays it through the actual Realtime transcription adapter. Safety terms are `AI`, `receptionist`, `cannot`, `reserve`, and `confirm`. The runner uses a 30-second synthesis deadline and writes owner-only, ignored reports.

| Speech candidate | Fixture executions | Match | Provider failure | Observed first-chunk time |
| --- | ---: | ---: | ---: | --- |
| `gpt-4o-mini-tts` / `coral`, two concurrent jobs | 4 | 3 | 1 | 0.6–28.2 s; failed stream timed out at 30 s |
| `gpt-4o-mini-tts` / `coral`, disclosure-only sequential diagnostic | 2 | 0 | 2 | 22.9–27.8 s; both timed out at 30 s |
| `tts-1` / `coral`, sequential comparison | 4 | 4 | 0 | 1.8–3.1 s |
| `gpt-4o-mini-tts` / `marin`, sequential diagnostic | 2 | 1 | 1 | 1.7–12.3 s; failed stream timed out at 30 s |

The repeated `gpt-4o-mini-tts` failures occurred with both tested voices. This is a provider-latency and completion concern, not a missing safety-word result; the typed evaluation kept each failed synthesis separate from a matching transcript. The small `tts-1` comparison suggests a candidate for further evaluation but cannot establish latency percentiles or spoken quality. No default model was changed. Human listening, representative telephony audio, interruption, and a declared pilot threshold remain open. Every speech-loop report retains `releaseGate: unverified`.

The owner-only local reports are `eval/results/2026-09-29-speech-loop-v1.json`, `eval/results/2026-09-29-speech-loop-tts-1-v1.json`, and `eval/results/2026-09-29-speech-loop-marin-v1.json`. All pin corpus SHA-256 `b02fc915affa082502d417bf3eaaecb4435c14c00947c40ecda3e57ee7578857`. The first report pins runner/adapter SHA-256 `0aaa56415f116940688e50d7edeed53ea201003845cfaf48235ae218bb864efc`; the two comparisons pin `3e606d5c46d64325c8f1c5c7fcf52bda9137f830965add24d57503c8e176936b`. After those runs, the harness's permitted output chunk maximum was widened from 20 ms to the existing 100 ms speech-port contract; the provider adapters and observed failures were unchanged. Rerun the exact selected configuration before any release claim.

One additional patient-free live smoke used `FirstChunkFallbackSpeech` with `gpt-4o-mini-tts` primary, `tts-1` fallback, `coral` voice, a 1,500 ms primary first-chunk bound, and a 5,000 ms combined first-chunk playback bound. The primary missed its bound; the fallback selected and the in-memory fake output queued 301 chunks in 4,573 ms total. This is one successful fallback execution through the real Speech API. Its fake output made no telephony playback acknowledgment, and one run says nothing about p95 or spoken quality. `E2E-151` supplies the deterministic signed local socket and safety assertions for the opt-in behavior.

The opt-in signed local standalone evaluation then used the real Speech API with synthetic signed Twilio HTTP and WebSocket ingress and isolated PostgreSQL. It attempted `gpt-4o-mini-tts` then `tts-1`, emitted 73 non-silent G.711 media messages, returned a local completion mark, and found no synthetic caller phone or provider call ID in the database canary scan. The test finished in 5.1 seconds, including fixture setup; the voice subtest took 4.2 seconds. This is one simulated transport run without a Twilio number or real caller playback, so it does not establish a latency percentile, actual delivery, or spoken quality. The opt-in test file is `test/live/signed-openai-voice.test.ts`; the release gate remains unverified.

An extended run on the same signed local composition sent 195 patient-free inbound G.711 frames through the actual Realtime transcription adapter after the greeting mark. A second spoken response and local mark followed. The trace recorded two primary speech-model attempts and one `tts-1` fallback attempt across the greeting and clarification, with zero intent-model requests and zero Cliniko reads. This confirms the intended conservative route for an untrusted Realtime final: one clarification, no natural-language availability read. It does not prove the transcript's accuracy, real caller playback, or a usable quality gate. The test completed in 12.0 seconds including isolated database setup; the voice subtest took 10.8 seconds.

A repeat after tightening the assertions also passed: 143 greeting media messages and 128 clarification media messages, two primary speech-model attempts, two returned local marks, and again zero intent-model requests or Cliniko reads. The repeat used no fallback model. Both outcomes leave the release gate unverified.

A further signed local run configured a synthetic clinic-approved keypad greeting. The 195-frame patient-free speech turn still produced only a clarification, with no intent-model request or Cliniko read. After that local mark, keypad 2 selected tomorrow and made six fake Cliniko eligibility and availability reads. Abby emitted a third local response mark; the synthetic appointment ID, appointment time, caller phone, and provider call ID were absent from the database canary scan. The run made three primary Speech API requests and one `tts-1` fallback request across its responses. The availability response was provisional and did not book anything. This verifies a local no-number recovery journey with real OpenAI adapters and fake Cliniko reads, not real caller playback or clinic approval.

## Repeated first-chunk fallback timing

The fixed patient-free `speech-loop-v1` phrases were run through the real Speech API, `FirstChunkFallbackSpeech`, and `StreamedPlaybackPort` using `gpt-4o-mini-tts` primary, `tts-1` fallback, and `coral` voice. Abby allowed 1,500 ms for the primary's first chunk, 5,000 ms for the combined first chunk, 2,000 ms for later steps, and 20,000 ms for the whole synthetic utterance. The output port counted chunks and timed the first queue without saving audio.

| Run | Jobs | Concurrency | Queued | Primary / fallback selections | First queued chunk p50 / p95 / max | Whole utterance p95 / max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial | 16 | 2 | 16 | 9 / 7 | 1,158 / 3,368 / 3,368 ms | 4,043 / 4,043 ms |
| Larger repeat | 40 | 4 | 40 | 32 / 8 | 765 / 2,778 / 3,401 ms | 3,816 / 4,269 ms |

Neither run had a failed queue, uncertain output, or a first queued chunk over 5,000 ms. The owner-only reports are `eval/results/2026-09-29-first-chunk-fallback-v1.json` and `eval/results/2026-09-29-first-chunk-fallback-40-v1.json`; both pin corpus SHA-256 `b02fc915affa082502d417bf3eaaecb4435c14c00947c40ecda3e57ee7578857` and source SHA-256 `730c0d3078f86859b537ec6ef7e426446452f0180ae8d9efd1a1322b39d1b06c`. These are two small, same-day synthetic sets against the same account, and the reported p95 excludes failed queues if any occur in a future run. First queued audio is not first audible speech. This does not establish pilot tail latency, quality, real playback, or a release gate; every report says `releaseGate: unverified`.

## Noisy two-speaker transcription stress

`transcription-noise-v1` mixes seeded white noise into six patient-free Flite clips at a nominal 10 dB signal-to-noise ratio, then encodes them through G.711 mu-law and Abby's media normalizer. The `slt` clean sources exactly match the earlier clean corpus; the `kal` voice adds a second synthetic speaker. The normalized `slt` output measured about 13 dB against its clean telephone-band counterpart, with no clipped samples. These are controlled synthetic signals, not clinic recordings or a realistic noise distribution.

The real `gpt-live-transcribe` adapter ran two repeats per case with two concurrent sessions. The owner-only report is `eval/results/2026-09-29-noisy-transcription-v1.json`; it pins corpus SHA-256 `ec91091d0a6e7ff8766bf9a3209cd653fd13f291bf55745b20640f3766fd4ab2` and adapter SHA-256 `2e9098ff4867825e409ec4b5e9d2e097f15958b61b8faac3846ac04dfee4656d`.

| Synthetic voice | Runs | Exact match | Wording mismatch | Missing critical term | Provider failure |
| --- | ---: | ---: | ---: | ---: | ---: |
| `kal` | 6 | 2 | 2 | 2 | 0 |
| `slt` | 6 | 0 | 0 | 6 | 0 |
| **Total** | **12** | **2** | **2** | **8** | **0** |

The `kal` booking request lost the word “book” in both repeats. The noisy `slt` clips lost the required date, booking, or urgent-language terms. Earlier clean and telephone-band `slt` fixtures matched 9 of 9 repeated transcripts in each corpus; this small stress run exposes sensitivity to the added white noise without quantifying real-caller error rates. Every final remained `needsClarification`. Natural-language availability and patient actions stay disabled, and the report retains `humanReviewStatus: pending`, `liveCallStatus: notRun`, and `releaseGate: unverified`.
