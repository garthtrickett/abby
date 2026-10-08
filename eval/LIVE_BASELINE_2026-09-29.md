# Live synthetic evaluation baseline — 2026-09-29

All runs used patient-free synthetic fixtures, an account-provided OpenAI API key, and owner-only reports under ignored `eval/results/`. No key value or real patient content is in this file. The reports retain repeat-level proposals or transcripts for local review; this summary records only counts and configuration evidence.

## Latest synthetic investigation — 2026-10-07

The [number-free checkpoint](NUMBER_FREE_CHECKPOINT_2026-10-07.md#speech-investigation) records nine one-repeat Realtime screens on the unchanged pinned noisy corpus: implicit/disabled provider noise reduction, fixed FFT filtering with three models, native PCMU with two models, an audio-derived FFT floor and nonlocal means filtering. Each still loses critical terms and exceeds 10% WER. Two also exceed the latency bound. No candidate is promoted. The native PCMU remote wire-hash instrumentation failed; a separate exact six-case round-trip verifies only the offline transform. Complete-clip preprocessing and the adaptive future-audio estimate do not prove streaming suitability.

The owner selected synthetic audio for continued investigation. A supplemental two-voice corpus adds ordinary booking, date, time and correction phrases in quiet and seeded 10 dB noise. All eight quiet clips matched; four of eight noisy clips missed critical words, with 19.12% WER. One repeat cannot meet the gate's repeat minimum. These clips supplement the diagnostic and do not replace any pinned gate corpus. The current complete report set remains source-matched and failing; no production adapter, prompt, threshold or admission changed. [Aggregate evidence, commands and hashes](baselines/number-free-checkpoint-20261007-v1.json) preserve the results without copying transcripts.

## Paired noise-filter diagnostic — 2026-10-05

One bounded file-transcription screen compared the original six `transcription-noise-v1` clips with a fixed filter, one repeat per clip and two concurrent requests. Original PCM hashes were verified before processing. The existing installed FFmpeg 6.1.1 used `highpass=f=80,lowpass=f=3400,afftdn=nr=12:nf=-35:tn=1`, retaining 16 kHz mono PCM. Both arms used `gpt-transcribe`, the same generic patient-free English physiotherapy context and the unchanged exact critical-term/word-error checks. No production adapter, corpus, threshold or dependency changed.

| Arm | Jobs | Critical misses | Word errors / expected words | WER | Provider failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original | 6 | 2 | 8 / 44 | 18.18% | 0 |
| Filtered | 6 | 1 | 1 / 44 | 2.27% | 0 |

The filtered urgent-language case still omitted the critical word `chest` (`NS-006`). This fails the zero-critical condition despite lower aggregate WER. This candidate is not promoted; no extra repetitions, safety screen or streaming integration were run for it. Complete-recording request time cannot establish Realtime post-commit latency or audible carrier performance. The report states `syntheticGate: notAssessed`, `realtimeLatency: notMeasured` and `releaseGate: unverified`; production speech admission remains disabled under the existing failing complete gate.

Exact diagnostic command:

```sh
node --env-file=/home/gust/code/abby/.env /home/gust/code/abby/eval/results/screen-noise-filter-20261005.mjs transcription-noise-v1 /home/gust/code/abby/eval/results/20261005-noise-filter-paired-screen.json
```

Tracked job `Abby paired fixed-corpus noise-filter screen` completed exit 0 in nine seconds, log `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791182686617.log`. Exit 0 means the diagnostic/report completed, not that a quality gate passed. The owner-only ignored runner/report are retained locally: runner SHA-256 `7f037bcaf5b3f89e72b60b128d1620899179bdc0ed538f8077b9c780b9102a52`, report SHA-256 `4658e9bd4a62a57b8c467e4b3b53e17fee2bef0d19fe494af6b67e4547cf52fb`, unchanged corpus SHA-256 `ec91091d0a6e7ff8766bf9a3209cd653fd13f291bf55745b20640f3766fd4ab2`, context SHA-256 `8241f56c7e19445b09fe988c8c8a06506a81dad1c4d3440d14b78c8c07c18620`. The report pins every original and transformed clip hash; it contains synthetic transcript details locally, which are not copied here.

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

## Bounded file transcription comparison

The same pinned patient-free noisy corpus was submitted as in-memory 16 kHz WAV to OpenAI's file transcription endpoint. These were completed-recording requests, not Realtime sessions or live calls. Each model ran two repeats per case with two concurrent requests, without prompts or vocabulary hints. The [OpenAI file transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) currently recommends `gpt-transcribe` for bounded recordings; Abby's connected-call adapter still uses `gpt-live-transcribe`.

| Model and corpus | Runs | Exact match | Wording mismatch | Missing critical term | Provider failure | Request p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `gpt-transcribe`, clean | 6 | 6 | 0 | 0 | 0 | 822 / 1,011 ms |
| `gpt-transcribe`, telephone-band | 6 | 6 | 0 | 0 | 0 | 758 / 836 ms |
| `gpt-transcribe`, noisy two-speaker | 12 | 6 | 2 | 4 | 0 | 1,389 / 1,656 ms |
| `gpt-4o-transcribe`, noisy two-speaker | 12 | 2 | 4 | 6 | 0 | 880 / 1,317 ms |

For comparison, the earlier Realtime noisy run had 2 exact matches, 2 wording mismatches, and 8 missing-critical-term results across 12 runs. `gpt-transcribe` recovered all six `kal` critical terms but still lost the booking or urgent-language terms in four `slt` runs; its `slt` date requests retained the critical day with different wording. File request latency begins after the complete WAV is available, so it cannot be compared directly with the paced Realtime turn duration or caller response time. The small synthetic sample cannot establish production accuracy or a latency percentile.

Owner-only local reports are `eval/results/2026-09-29-clean-gpt-transcribe-v1.json`, `eval/results/2026-09-29-telephone-gpt-transcribe-v1.json`, `eval/results/2026-09-29-noisy-gpt-transcribe-v1.json`, and `eval/results/2026-09-29-noisy-gpt-4o-transcribe-v1.json`. They pin runner SHA-256 `b38c9fd28472dbe12ab9ab50396c0379d3c1b005e2182c62b9ec558ad4c0b88e` and the corpus hashes listed above. Every result remains `needsClarification` or `unavailable`; all four reports retain `releaseGate: unverified`. No model switch or caller action gate changed.

## Realtime committed-turn transcription comparison

The same adapter can now select OpenAI's documented `gpt-transcribe` committed-turn workflow for a bounded experiment. The [Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription#transcribe-a-committed-turn) describes this model's WebSocket session and detected-language output after a commit. `E2E-162` checks the selected session model, committed item correlation, mismatched configuration failure, and untrusted final. The production standalone composition still uses `gpt-live-transcribe`.

| Realtime `gpt-transcribe` corpus | Runs | Exact match | Wording mismatch | Missing critical term | Provider failure | Turn p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Clean | 6 | 6 | 0 | 0 | 0 | 4,869 / 5,247 ms |
| Telephone-band | 6 | 6 | 0 | 0 | 0 | 4,803 / 5,068 ms |
| Noisy two-speaker | 12 | 6 | 1 | 5 | 0 | 4,857 / 5,821 ms |

These patient-free runs used two repeats and two concurrent sessions per corpus, with the same 20 ms media-frame pacing and no context hints. The noisy result improves on the earlier `gpt-live-transcribe` run's 8 critical misses, but five misses still block promotion of natural-language caller turns. Turn duration includes paced fixture replay and connection setup, and cannot establish audible response latency. This small synthetic sample cannot select a production model or determine a pilot quality threshold.

The owner-only reports are `eval/results/2026-09-29-clean-realtime-gpt-transcribe-v1.json`, `eval/results/2026-09-29-telephone-realtime-gpt-transcribe-v1.json`, and `eval/results/2026-09-29-noisy-realtime-gpt-transcribe-v1.json`. They pin adapter SHA-256 `65104bd11ce1466bee5c367b2f11fee5f90dabcc63e61d92a4deddcd3243f3b2`. All finals remain `needsClarification`, and every report retains `releaseGate: unverified`.

## Declared synthetic speech gate — 2026-09-30

The [version 1 gate](SPEECH_QUALITY_GATE.md) was fixed before these final candidate runs. The same `gpt-live-transcribe` production adapter ran three repeats per case with four concurrent sessions. The speech path ran forty fixed patient-free synthesis jobs with four concurrent requests. The owner-only reports are ignored under `eval/results/`; no API key, patient audio, or caller record was saved in the repository.

| Check | Jobs | Candidate result | Accuracy or queue result | Measured latency |
| --- | ---: | --- | --- | --- |
| Telephone-band clean | 9 | Pass | 9 matches; 0 critical; WER 0% | Post-commit final p95 767 ms |
| 10 dB noisy, two synthetic voices | 18 | Fail | 12 critical misses; WER 43.2% | Post-commit final p95 837 ms |
| New 20 dB safety corpus, two synthetic voices | 24 | Fail | 11 critical misses; WER 27.2% | Post-commit final p95 866 ms |
| First queued speech chunk | 40 | Fail | 39 queued; 1 uncertain | Successful-job first-chunk p95 2,391 ms; utterance p95 2,944 ms |

The aggregate `eval:speech-gate` command returned nonzero. The successful-job speech p95 stayed below its threshold, but the uncertain job independently failed the gate. No noisy or safety transcript was promoted to `clear`; natural-language availability and patient actions remain disabled. The earlier same-day diagnostic reports became stale when gate source changed, so this table uses only the final, source-matched reports. The reports are `2026-09-30-transcription-telephony-final.json`, `2026-09-30-transcription-noise-final.json`, `2026-09-30-transcription-safety-final.json`, and `2026-09-30-first-chunk-final.json` inside the ignored `eval/results/` directory.

The transcription reports pin adapter/source SHA-256 `37064ad69bf3ff91df19923aa97039521864e512f48333dfc2b9cf9542ac0e4b`; their corpus hashes are respectively `65645afaeeaca6c91342b8e690c184affd58e004f3438cfa0cccfdd18e3f8e1a`, `ec91091d0a6e7ff8766bf9a3209cd653fd13f291bf55745b20640f3766fd4ab2`, and `fb261dfa87cfd036307346874b439b63596a7b9390109cc3d22965f5fda795da`. The speech report pins source SHA-256 `41fc6737cb726a8bac104db9828a688a0f0e614adbe065fe0a677f472c5773f4` and corpus SHA-256 `b02fc915affa082502d417bf3eaaecb4435c14c00947c40ecda3e57ee7578857`. Human listening and the representative carrier-call gate remain unrun. Every report retains `releaseGate: unverified`.

## Static clinic context comparison — 2026-09-30

The unchanged noise and safety corpora were run for three repeats per case with two bounded Realtime candidates. The first used `gpt-transcribe` without context on the existing adapter. The second used `gpt-live-transcribe` with a fixed, patient-free English physiotherapy setting prompt and `languages: ["en"]`. The prompt is an opt-in evaluation option; the standalone runner still uses unprompted `gpt-live-transcribe`. The provider's `session.updated` response echoed the prompt and language, and the adapter checked both. An earlier keyword-hint attempt failed its acknowledgment check because the provider did not echo `keywords`; those 18 provider failures are configuration-check failures and are excluded from the accuracy comparison.

| Candidate | Corpus | Runs | Critical misses | WER | Final p95 after commit | Gate |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Unprompted `gpt-live-transcribe` baseline | 10 dB noise | 18 | 12 | 43.2% | 837 ms | Fail |
| Unprompted `gpt-transcribe` | 10 dB noise | 18 | 9 | 22.7% | 1,200 ms | Fail |
| Prompted `gpt-live-transcribe` | 10 dB noise | 18 | 4 | 23.5% | 889 ms | Fail |
| Unprompted `gpt-live-transcribe` baseline | 20 dB safety | 24 | 11 | 27.2% | 866 ms | Fail |
| Unprompted `gpt-transcribe` | 20 dB safety | 24 | 11 | 21.1% | 898 ms | Fail |
| Prompted `gpt-live-transcribe` | 20 dB safety | 24 | 7 | 11.7% | 875 ms | Fail |

The prompted candidate reduced critical misses but did not meet the predeclared zero-critical or at-most-10%-WER thresholds. Its remaining noisy misses include the synthetic urgent-language case; the safety misses include a date and a weekday. Source prompts can also bias recognition toward expected terms, so these fixed phrases are diagnostic evidence, not proof of real-caller accuracy. The source-matched prompted reports are `eval/results/2026-09-30-live-context-prompt-noise-3.json` and `eval/results/2026-09-30-live-context-prompt-safety-3.json`, with adapter/source SHA-256 `09bfdca15d4648edcfd2ad31bab6c4cb37160ab0b9d1a788e95dd73308d56a7a`. The unprompted `gpt-transcribe` reports are `2026-09-30-gpt-transcribe-noise-3.json` and `2026-09-30-gpt-transcribe-safety-3.json`, with source SHA-256 `37064ad69bf3ff91df19923aa97039521864e512f48333dfc2b9cf9542ac0e4b`. All four are owner-only and ignored by Git, pin the unchanged corpus SHA-256 values above, and retain `releaseGate: unverified`.

The A3 investigation therefore has a documented blocker under the existing synthetic gate: degraded synthetic speech still loses safety terms despite a static clinic context. No quality threshold was relaxed, no candidate was promoted, and natural-language availability remains disabled. The next useful quality evidence is a representative, consented carrier corpus plus human review when an owned number is available; a separate number-free experiment may compare noise handling, but cannot replace that gate.

## Multi-turn model follow-up comparison — 2026-09-30

The patient-free `model-multiturn-v1` corpus supplies one prior caller turn and one current turn per case. Seven cases cover a relative-date correction, a withdrawn booking, a shared-phone identity claim, pressure to invent an unsupported answer, urgent language after an earlier booking request, a correction to a staff request, and an administrative question after withdrawing a clinical one. The production Responses adapter sent only the bounded prior/current caller text and approved knowledge as JSON data with `store: false`; no call, tenant, or patient ID entered the request. The fixed `prompt-v3` says the current turn supersedes prior caller text and neither turn proves identity or confirms an action.

`gpt-6-luna` produced 21 matching typed proposals across three repeats per case, with zero mismatches, critical errors, or provider failures. All three relative-date corrections proposed `book` without an invented absolute `requestedTime`; all shared-phone cases proposed patient lookup, all urgent and unsupported cases proposed handoff, and the two approved administrative cases used exact source text. The final source-matched owner-only report is `eval/results/2026-09-30-model-multiturn-v2.json`, with prompt SHA-256 `f957089b61422fd93976ccac8d7419e19c25f393635d134b68386637d2006140`, corpus SHA-256 `9eda1f8d5aae09315d121356648d0b43322dc1f3ead56b45aeca552bc6fb87ea`, and adapter/source SHA-256 `4986af7adaa6d101624e4a99cede8b254213a70bf3cb2c18cfb05dd142a29dab`. The report remains `releaseGate: unverified`.

The synthetic whole-call model journey separately proves that accepted model-routed caller turns enter only process-local, scoped context; an older pending model effect is canceled by a correction; the context is absent from the ledger; and no model `book` proposal dispatches a host booking write. The live evaluation invokes the model proposal boundary with predeclared prior turns rather than making a carrier call. It does not test speech accuracy, patient verification, real clinic wording, or model behavior after its 60-second transient history expires. The failing speech gate above still blocks natural-language availability and patient actions.

## Restored-key speech gate rerun — 2026-10-01

The owner-only Abby `.env` was restored in the active checkout from the earlier owner-only local file. The four unchanged, patient-free corpora were rerun with the current unprompted `gpt-live-transcribe` and primary `gpt-4o-mini-tts` / fallback `tts-1` configuration. Transcription used three repeats per case and four concurrent sessions; synthesis used twenty repeats per message and four concurrent jobs. `node scripts/assess-speech-evaluation.ts` returned a failing synthetic candidate gate without relaxing thresholds.

| Check | Result | Critical misses or queue failures | Other measured result |
| --- | --- | ---: | --- |
| Telephone-band clean | Pass, 9/9 runs | 0 critical | WER 0%; final p95 740 ms |
| 10 dB noisy | Fail, 18 runs | 12 critical | WER 41.7%; final p95 786 ms |
| 20 dB safety | Fail, 24 runs | 11 critical | WER 23.3%; final p95 829 ms |
| First queued speech chunk | Fail, 40 jobs | 0 failed or uncertain | First-chunk p95 3,983 ms exceeds 3,500 ms; utterance p95 4,408 ms |

The ignored, owner-only reports are `eval/results/2026-10-01-{telephony,noise,safety,speech}-refresh.json`. Their report SHA-256 values in that order are `3a29898d85e427720d2d17c8bc8a2c6679741e4570c9eedc6717f9daa97b75da`, `ab721effdf4d4dd1a1fc4262895af2e89fc21eb413a0f7d1745ddd4bc42a2c87`, `527de112228dcbc05acaa25c322b7e7043e3ab7351790d79338654ea5698662f`, and `e0e858c03e6fbf8439bd690b12df463f45ba4cfd620d9d2805adbf208206d7b4`. The transcription adapter/source hash is `09bfdca15d4648edcfd2ad31bab6c4cb37160ab0b9d1a788e95dd73308d56a7a`; the speech source hash is `a8229a8667b1dab890a7d507190d6b16240d7fadd5b50fdd664b0b0d3c2fcb48`. The reports pin the same corpus hashes listed for the previous gate. Every report still says `releaseGate: unverified`; no real call or human review occurred. Natural-language availability and patient actions remain disabled.

## Optional transcription delay screening — 2026-10-01

[OpenAI's Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription#tune-latency-and-accuracy) describes `audio.input.transcription.delay` as an accuracy/latency setting. The adapter and evaluation runner now accept a bounded, opt-in delay; the standalone voice runner still omits it. A direct patient-free session update requesting `high` returned `session.updated`, but that response did **not** echo `delay`. The first strict-echo evaluation therefore returned 18 provider failures before any transcript; these are configuration-acknowledgment failures, not audio accuracy results. The adapter continues to verify the model and any supplied static context, while an opt-in delay is recorded as requested but unacknowledged by the provider.

A six-case screening run requested `high` with the existing `clinic-v1` static context on the unchanged 10 dB noisy corpus, one repeat per case and two concurrent sessions. It yielded four exact matches, one wording mismatch, one missing booking term (`NS-005`), zero provider failures, 20.5% word error rate, and 1,040 ms post-commit final p95. This is **not** the declared three-repeat gate; it already misses the zero-critical and 10% WER requirements, so the candidate was not extended to the safety and clean corpora or promoted. Its ignored owner-only report is `eval/results/2026-10-01-noise-context-delay-high-screen.json`, SHA-256 `c0b207396ad9703bdfbd6ab34eee3186d89a4a130b361bfbb40e8e1b45b22cb7`. The report pins corpus SHA-256 `ec91091d0a6e7ff8766bf9a3209cd653fd13f291bf55745b20640f3766fd4ab2` and adapter/source SHA-256 `dda23c31be54108f5805e3a45983fa7eadc025b149a07cff41ac259542c475f2`. That source hash describes the screening checkout before its final type-only cleanup; the retained report remains an investigation record, not a source-matched gate input. Requested delay may not have been applied because the provider did not echo it. No caller capability changed.

The production configuration (no context or delay) was then rerun against all three unchanged transcription corpora after the final adapter edit. The existing 40-job speech report still matched its unchanged source. `node scripts/assess-speech-evaluation.ts` accepted all four report/source hashes and returned a failing candidate gate:

| Check | Runs | Critical misses | WER | Other result |
| --- | ---: | ---: | ---: | --- |
| Telephone-band clean | 9 | 0 | 0% | Pass; final p95 745 ms |
| 10 dB noisy | 18 | 12 | 43.2% | Fail; final p95 1,070 ms |
| 20 dB safety | 24 | 11 | 26.1% | Fail; final p95 847 ms |
| First queued speech chunk | 40 | 0 failed jobs | — | Fail; first-chunk p95 3,983 ms |

The ignored reports are `eval/results/2026-10-01-{telephony,noise,safety}-delay-source.json` plus `2026-10-01-speech-refresh.json`. The three new report SHA-256 values are `1a6a7eb9646d41c2c81b41f41ce640c2e0e494d761685476f2026a976168ea5f`, `cb6cc5b2c551640151efeec7b487b80f5fb1a12006126ef806bbeea6749237ed`, and `b15a9f010b2e7066e242cf1ae0c05dcbed93eaed2e974694fcf37ad2dfa551bf`, respectively; all pin adapter/source SHA-256 `36e9ff675ebb8a4677217fae9da317ec8232ffcbdb7eab046302ec135e41d386`. The speech report's SHA-256 is `e0e858c03e6fbf8439bd690b12df463f45ba4cfd620d9d2805adbf208206d7b4`. The caller route still emits only clarification for completed Realtime transcripts; the representative call and human listening gates remain unrun.

## Local `.env` key check and live gate rerun — 2026-10-01

`ABBY_OPENAI_API_KEY` was present and nonempty in the ignored Abby `.env`; it was not exported in the shell. Running the evaluation commands with Node's `--env-file=.env` loaded that key without copying it into source or output. The unchanged production configuration was rerun against all three transcription corpora and the 40-job first-chunk corpus. The four owner-only reports share the prefix `eval/results/20261001T104207Z-key-check-`; `node scripts/assess-speech-evaluation.ts` accepted their current source hashes and returned a failing synthetic candidate gate. Telephone-band clean passed (9 runs, zero critical misses, 4.5% WER, 767 ms final p95). Noise failed (18 runs, 12 critical misses, 43.9% WER, 3,787 ms final p95); safety failed (24 runs, 11 critical misses, 28.9% WER); speech failed (40 jobs, three failed, 3,739 ms first-chunk p95). The tracked run exited 1 because the declared thresholds failed, not because the key was unavailable. Representative carrier calls and human listening remain unrun; the release gate is unverified.

## Static-context transcription and `tts-1` primary screens — 2026-10-01

The unchanged noisy and safety audio corpora were screened once per case with Realtime `gpt-transcribe` and the existing patient-free `clinic-v1` context. Noise had one critical miss in six cases and 11.4% WER; safety had five critical misses in eight cases and 18.3% WER. These one-repeat screens cannot pass the declared three-repeat gate and already miss its zero-critical and 10% WER limits. The remaining noisy miss was an urgent symptom, so this configuration is not promoted. The ignored reports are `eval/results/20261001-a3-gpt-context-{noise,safety}-screen.json`, with SHA-256 `3f6eee8f8c5e4c08fee19630b0f6c0f653b592dc982298de70b2f0ef230f6202` and `22b7cca6413e554eeb45256d4c8c5ad459983852069cc88b748db6bd0a2a7c75`; both pin transcription source hash `36e9ff675ebb8a4677217fae9da317ec8232ffcbdb7eab046302ec135e41d386`.

The first-chunk runner now accepts an explicitly named, pinned `tts-1` primary candidate. Both primary and fallback used `tts-1` with a 2,500 ms pre-audio switch bound; this is a same-model retry if the first attempt misses that bound. The 12-job screen queued all jobs but missed the declared 3,500 ms p95 by 57 ms. A separate full 40-job run with four concurrent jobs queued all 40, selected the primary all 40 times, had zero failed or late jobs, first queued chunk p95 **2,124 ms**, and full utterance p95 **2,650 ms**. The ignored reports are `eval/results/20261001-a3-tts1-primary-{screen,40}.json`, with SHA-256 `8532c6943a4d714cc06ec04a634606ba41ed6074492cd7f485d40297c4c46798` and `bd985f5bcc9f4cf4073b1efce0df878aca8b99a06782a1a537c8b9c213ec7b4f`; both pin speech corpus hash `b02fc915affa082502d417bf3eaaecb4435c14c00947c40ecda3e57ee7578857` and evaluation source hash `37d8cbd77d2f1819e8d960f04f336bed04d9af1b69636aee89e8ca2a4b1c1b16`.

The exact-profile assessor accepted the 40-job speech report and the current unprompted transcription reports. The speech **latency subgate passed**; the combined synthetic gate still **failed** on noisy and safety transcription. The default-profile assessor rejected the `tts-1` report, as intended. This is one provider-day latency result and has no audible-carrier or human-listening evidence. The standalone voice runner and natural-language admission remain unchanged; every report retains `releaseGate: unverified`.

## Optional keyword-hint screening — 2026-10-01

[OpenAI's Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription#add-transcription-context) permits static keyword hints. The adapter and evaluation runner now accept a bounded, opt-in patient-free keyword list alongside the existing prompt and language hint. A live session accepted the update, but `session.updated` omitted the keyword list; the adapter therefore treats the requested hints as unverified rather than proof of application. The standalone runner still supplies neither context nor keywords.

The `clinic-keywords-v1` candidate used the existing English physiotherapy-clinic prompt and language hint plus four general clinic terms: `physiotherapy`, `appointment`, `booking`, and `urgent`. On the unchanged 10 dB noisy corpus, one repeat per six cases at two concurrent sessions yielded three exact matches, two wording mismatches, one missed critical term in the synthetic urgent-language case (`NS-006`), zero provider failures, **27.3% WER**, and 859 ms post-commit final p95. The declared gate requires three repeats, zero critical misses and at most 10% WER. This candidate failed the screen, so no safety-corpus or full-gate run was warranted and no caller behavior changed.

The owner-only report is `eval/results/20261001-a3-keywords-noise-screen.json`, SHA-256 `d66b61d4f3e2ccac9199b707346725b0fd72a5ad484c34daffa7ceac58b0e746`. It pins the unchanged noise corpus SHA-256 `ec91091d0a6e7ff8766bf9a3209cd653fd13f291bf55745b20640f3766fd4ab2` and adapter/evaluator source SHA-256 `2b15d86cfbb7d5edc8c75b8993b4f60408f3f435af944823b2568884ef115928`. The report retains `releaseGate: unverified`. Neither the source-matched prompt-only results nor this one-repeat screen establishes that keyword hints improved recognition; the remaining urgent miss still blocks the fixed gate.

## Combined committed-turn and keyword screen — 2026-10-01

One further bounded candidate combined the existing `gpt-transcribe` committed-turn option with the unchanged `clinic-keywords-v1` static prompt, English hint and four patient-free terms. The unchanged six-case 10 dB noisy corpus ran once per case with two concurrent Realtime sessions. Four transcripts matched exactly, one had different noncritical wording, and one missed the urgent phrase: `NS-006` (“chest pain”) became “fasting.” The run had zero provider failures, 13.6% WER and 1,399 ms post-commit final p95. It failed the fixed zero-critical and 10% WER criteria; one repeat also cannot meet the three-repeat minimum. The safety corpus and full gate were therefore not run for this candidate.

The ignored owner-only report is `eval/results/20261001-a3-gpt-keywords-noise-screen.json`, SHA-256 `e6aa649ad80de14f6135f7b24a03bb6eb44e88b07efa42e1b0cfcd2a29c8ca44`. It pins noise corpus SHA-256 `ec91091d0a6e7ff8766bf9a3209cd653fd13f291bf55745b20640f3766fd4ab2` and adapter/evaluator source SHA-256 `2b15d86cfbb7d5edc8c75b8993b4f60408f3f435af944823b2568884ef115928`. As in the earlier keyword screen, the provider did not echo the keywords in its session acknowledgment, so whether that hint was applied remains unverified. A one-repeat difference from other screens is not an accuracy ranking. The unchanged production runner keeps natural-language turns gated and the report keeps `releaseGate: unverified`.

## Realtime Whisper noisy-corpus screen — 2026-10-01

[Official OpenAI documentation](https://developers.openai.com/api/docs/models/gpt-realtime-whisper) lists `gpt-realtime-whisper` as a Realtime transcription model. Abby's existing adapter and evaluation runner now accept it only as an explicit model option; the standalone voice runner still selects unprompted `gpt-live-transcribe`, and all completed transcripts remain `needsClarification`.

The unchanged six-case 10 dB noisy corpus ran once per case with two concurrent sessions and no context. One transcript matched exactly, one differed without a critical miss, and **four missed critical terms**. There were no provider failures, but word error rate was **40.9%** and post-commit final p95 was **770 ms**. The declared gate requires three repeats, zero critical misses and at most 10% WER. This screen already fails its accuracy conditions, so the safety corpus and full gate were not run for this candidate. The single repeat is diagnostic, not a model ranking or a passing gate.

The ignored owner-only report is `eval/results/20261001-a3-whisper-noise-screen.json`, SHA-256 `fdd170c554de7bcd2f3a7c0e2a178c5dea83f9528d8c33369eea63d5e3978072`. It pins the noise corpus SHA-256 `ec91091d0a6e7ff8766bf9a3209cd653fd13f291bf55745b20640f3766fd4ab2` and adapter/evaluator source SHA-256 `3434af7f123df04869af6797154e0b6a84f0fbb097fe688a66bf117ab48ef6b3`. The report has mode `0600`, contains only patient-free fixture audio results, and retains `releaseGate: unverified`. No natural-language caller capability changed.

## Owner-status source-matched rerun — 2026-10-01

The current unprompted production candidate was rerun on all four unchanged patient-free corpora after the opt-in candidate work. Node loaded `ABBY_OPENAI_API_KEY` from Abby's ignored `.env`; no key value was printed or committed. Three repeats per transcription case and twenty repeats per speech message used four concurrent provider jobs within each serial corpus run. The source-matched assessor accepted the four reports and recorded their absolute paths in an ignored, owner-only local report set. `npm run voice:ops:speech` then recomputed the aggregate checks from that set and exited `2` for a validated failing candidate.

| Check | Runs | Critical misses or failed jobs | WER | Latency and result |
| --- | ---: | ---: | ---: | --- |
| Telephone-band clean | 9 | 0 | 4.55% | Final p95 798 ms; pass |
| 10 dB noisy | 18 | 12 | 43.18% | Final p95 1,608 ms; fail |
| 20 dB safety | 24 | 10 | 25.56% | Final p95 824 ms, one final beyond 5 seconds; fail |
| First queued speech chunk | 40 | 0 failed or late jobs | — | First chunk p95 3,121 ms; utterance p95 3,872 ms; pass |

The ignored owner-only report files are `eval/results/20261001-d3-current-{telephony,noise,safety,speech}.json`. Their SHA-256 values in that order are `d91c35a092adfc485ffb01d0939c9e26c8845a4ade1a92e3d57edd3228904bb7`, `4048e57031e34e2eae1d32a21c0d84b7e6d94f8dd2b9e318b8551ef602b259ac`, `7fa3b46bd1da44364a62b0a6b12295c74fd31d0bfc36381b212fc2e240e57e76`, and `0fd121d363f5e43d09156b7b4c7afdb8118b62ef52d79b444c7c0f514f9c734d`. The report set is `eval/results/current-speech-gate.json`, SHA-256 `d141b5e28ecdab59960647e2a0b2e1e4fb123c835d4fa3e34ddcf872d30085d3`. Its paths are local to this checkout; the tracked hash is the durable evidence reference.

All three transcription reports pin current adapter/evaluator source SHA-256 `3434af7f123df04869af6797154e0b6a84f0fbb097fe688a66bf117ab48ef6b3` and the previously listed pinned corpus hashes. The speech report pins source SHA-256 `37d8cbd77d2f1819e8d960f04f336bed04d9af1b69636aee89e8ca2a4b1c1b16` and speech corpus SHA-256 `b02fc915affa082502d417bf3eaaecb4435c14c00947c40ecda3e57ee7578857`. This run changes the observed synthesis result, not the declared threshold or the failed combined gate. It does not include real carrier audio, human listening, a clinic decision, or patient calls. Every report retains `releaseGate: unverified`; the status says `representativeCallGate: notRun`.

## Opt-in input noise-reduction screens — 2026-10-01

[OpenAI's Realtime session configuration](https://github.com/openai/openai-agents-python/blob/main/src/agents/realtime/config.py) exposes `audio.input.noise_reduction` with `near_field` and `far_field` modes. Abby's adapter and evaluation runner now accept either mode only when explicitly requested. The standalone caller runner still omits the setting, and every final transcript remains untrusted. The provider accepted both session updates and produced finals; the run did not independently prove that the requested audio processing was applied.

The unchanged six-case 10 dB noisy corpus ran once per case at two concurrent sessions, without prompt, keywords or delay. `near_field` had two noncritical mismatches, **four critical misses**, 50.0% WER and 773 ms final p95. `far_field` had two noncritical mismatches, **four critical misses**, 34.1% WER and 711 ms final p95. Neither run had provider failures, but both already fail the fixed zero-critical and 10% WER requirements. The three-repeat gate and safety corpus were not run for either mode. The one-repeat results do not rank the modes or establish a reliable improvement over the default.

The ignored owner-only reports are `eval/results/noise-{near,far}-field-screen-2026-10-01.json`, SHA-256 `6dc336c9b57c464c29a3dab8b16e462ada1dc61a63879e4a882d4e06e308da72` and `059abc9c03600a74cc7bb1fe9f54a5939e584dc23feed02fafed54b386d19d08`. Both pin corpus SHA-256 `ec91091d0a6e7ff8766bf9a3209cd653fd13f291bf55745b20640f3766fd4ab2` and adapter/evaluator source SHA-256 `8f307ebb669b79d63509b0705bbd291100c48eb6c2272bd431f7f2e38c29e24d`. Each report retains `releaseGate: unverified`. Natural-language caller admission remains disabled.

## Current-source operator status after noise-reduction screens — 2026-10-01

After adding the opt-in evaluation control, the unchanged default `gpt-live-transcribe` candidate was rerun on all three patient-free transcription corpora, three repeats per case and four concurrent sessions. The assessor rejected opt-in delay or noise-reduction reports as default-profile evidence, then accepted the three fresh default reports plus the unchanged source-matched 40-job speech report. `npm run voice:ops:speech` exited `2` for a validated failing candidate:

| Check | Runs | Critical misses or failed jobs | WER | Result |
| --- | ---: | ---: | ---: | --- |
| Telephone-band clean | 9 | 0 | 4.55% | Pass; final p95 780 ms |
| 10 dB noisy | 18 | 12 | 42.42% | Fail; final p95 786 ms |
| 20 dB safety | 24 | 10 | 24.44% | Fail; final p95 838 ms |
| First queued speech chunk | 40 | 0 failed jobs | — | Pass; first-chunk p95 3,121 ms |

The ignored owner-only reports are `eval/results/20261001-noise-option-source-{telephony,noise,safety}.json`, SHA-256 `7c0b61b1efd110b37282cc7229366ad831efc8980aea7355764aa6d24888dbbc`, `16ac666b9f86ae10ead88b384023bdf72e1d3e17790a533919a201a742c31bdc`, and `866a48fb5bb81c2075a0cbf070a3a50fc98f01f2193b0b08559a02ecef4dfc66`. All three pin adapter/evaluator source SHA-256 `8f307ebb669b79d63509b0705bbd291100c48eb6c2272bd431f7f2e38c29e24d`. The owner-only set at `eval/results/current-speech-gate.json` points to these reports and the existing source-matched `20261001-d3-current-speech.json` report. Its hash is checkout-specific because it contains absolute report paths; the report hashes above are the portable evidence. Natural-language caller admission and the representative-call gate remain closed.

## Prompted file-transcription screen — 2026-10-02

[Official OpenAI Docs](https://developers.openai.com/api/docs/guides/speech-to-text#add-transcription-context) support a fixed prompt, keyword hints and a language hint for completed-recording `gpt-transcribe` requests. Abby screened that option without changing its live Realtime adapter. The opt-in `clinic-v1` context used the same patient-free English physiotherapy prompt and four general clinic keywords as the earlier Realtime probe. Node loaded the owner-only key from Abby's ignored `.env`; the request contained only the six pinned patient-free noisy audio fixtures and static context.

One repeat per case with two concurrent requests returned three exact matches, one wording mismatch, two missing-critical-term results and zero provider failures. `NS-005` missed “book”; `NS-006` missed “chest”. Word error rate was 7/44, or **15.9%**, and completed-file request p95 was **1,730 ms**. The fixed synthetic candidate threshold requires zero critical misses, at most 10% WER and three repeats per case. This screen already fails, so the safety corpus and larger repeat were not run. Request timing starts after the entire clip is available; it is not audible response latency or a live-call measurement. This small screen does not rank file against Realtime transcription.

The ignored owner-only report is `eval/results/20261002-file-clinic-noise-screen.json`, SHA-256 `3bbffb8af7464e2c5ac6ae5c3da0f06e14676b5c99770c8abdb827b60013ea52`, mode `0600`. It pins the unchanged noisy corpus SHA-256 `ec91091d0a6e7ff8766bf9a3209cd653fd13f291bf55745b20640f3766fd4ab2`, context SHA-256 `8241f56c7e19445b09fe988c8c8a06506a81dad1c4d3440d14b78c8c07c18620` and evaluator source SHA-256 `758f441292c4b6feb90db122fec8eee9bd7a26af32089fed3ba32e27e7db246b`. The report remains `releaseGate: unverified`. No production transcription model, prompt or caller capability changed.
