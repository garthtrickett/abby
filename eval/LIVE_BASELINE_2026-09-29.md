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
