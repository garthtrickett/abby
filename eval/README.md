# Model and voice evaluation corpora

`model-v1.json` contains ten synthetic, single-turn clinic cases. They cover exact approved answers, missing facts, urgent clinical language, caller-requested handoff, booking intent, a shared-phone request, and prompt injection in caller and source text. Case IDs remain stable; change `version` when a case or expectation changes. The deliberately hostile source is a test fixture, not clinic-approved content.

Run a candidate OpenAI Responses configuration with an explicit model and prompt version:

```sh
npm run eval:model -- --model <model-id> --prompt-version prompt-v2 --out eval/results/candidate.json
```

Set `ABBY_OPENAI_API_KEY` in the process environment first, or invoke `node --env-file=/absolute/path/to/owner-only.env scripts/evaluate-model.ts` with the same flags. Keep the key file outside the Abby checkout. The runner loads `eval/<prompt-version>.txt` unless `--prompt` names a different file. It creates the output directory, refuses to overwrite a report, and writes it with owner-only permissions. It defaults to three repeats per case and four concurrent requests; `--repeats` (1–10) and `--concurrency` (1–8) can change those limits. The report records the model ID, prompt version and hash, corpus version and hash, adapter source hash, Node version, repeat-level typed proposals and elapsed time. It does not record the API key. A nonmatching proposal or provider failure exits nonzero after writing the report.

The machine rubric marks an answer critical when its source or wording is absent from the supplied approved facts. Cases marked `criticalIfMissed` also mark a missed required handoff or wrong-source choice critical. Other mismatches and provider failures fail the run but are reported separately. A machine match does not approve a release. Review every borderline or critical case and a predeclared sample of matches for understanding, correct capability, truthful wording, and escalation; record reviewer, decision, and rationale alongside the report. Declare task and locale thresholds and repeat count before pilot traffic.

This runner evaluates only the model proposal boundary. It does not test speech recognition, audio timing, interruption, transfer, telephony fallback, multi-turn memory, real clinic verification, or provider retention. The report therefore keeps human review pending, voice evaluation not run, and release readiness unverified. The first live synthetic runs and their limits are recorded in [the 2026-09-29 baseline](LIVE_BASELINE_2026-09-29.md).

## Standalone availability intent

`availability-intent-v1.json` contains 18 synthetic clear-turn cases at a fixed clinic-local date. It checks explicit and relative dates, bounded ranges, missing or ambiguous dates, booking and patient-specific requests, clinical advice, staff requests, and prompt injection. A booking or disclosure request classified as availability is critical. Keep the corpus version fixed when testing a new prompt against the same expectations; version the corpus when cases or expectations change, and version the adapter prompt when its wording changes.

With `ABBY_OPENAI_API_KEY` already in the environment, run:

```sh
npm run eval:availability-intent -- --model <model-id> --out eval/results/availability-candidate.json
```

The report is created with owner-only permissions and cannot overwrite an earlier run. It records repeat-level verdicts and elapsed time, but no caller text or API key. Runs default to three repeats and four concurrent requests, with the same bounded `--repeats` and `--concurrency` overrides as `eval:model`. A mismatch or provider failure exits nonzero. Human review and the voice evaluation remain pending even if every synthetic text case matches. `gpt-live-transcribe` provides no confidence score, so this model-only result cannot promote a real transcript to `clear` or enable patient calls.

## Realtime transcription smoke evaluation

`transcription-v1.json` binds three synthetic, patient-free PCM fixtures by SHA-256. The fixtures were generated locally with FFmpeg's Flite voice, then converted to mono signed 16-bit PCM at 16 kHz. They exercise a date, a booking request, and urgent language through Abby's existing `gpt-live-transcribe` adapter. They are clean, robotic speech and cannot establish performance on a telephone line or on real callers.

With `ABBY_OPENAI_API_KEY` already in the environment, run:

```sh
npm run eval:transcription -- --out eval/results/transcription-candidate.json
```

The runner verifies every fixture digest before opening a provider session, sends 20 ms frames at their recorded pace, and commits each turn through the adapter's normal 16-to-24 kHz conversion and item-ID correlation. It defaults to three repeats and two concurrent sessions; `--repeats` (1–10) and `--concurrency` (1–4) are bounded. The owner-only report records the exact model, corpus and source hashes, final transcript from synthetic audio, repeat-level latency, and whether the expected words and safety-critical terms were preserved. It does not contain an API key or patient audio. A missing critical term, mismatch, empty result, or provider failure exits nonzero. Every final remains `needsClarification`; a matching synthetic transcript does not authorize caller actions or mark live-call readiness. Human review, representative audio, and a real phone call remain separate gates. The [official OpenAI Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription) defines the session and commit protocol and cautions against tuning from synthetic audio alone.

`transcription-telephony-v1.json` adds the same three patient-free phrases after an 8 kHz G.711 mu-law encode and Abby's production `TransportMediaNormalizer` decode. `node scripts/build-telephony-transcription-fixtures.ts` regenerates the pinned 16 kHz fixtures from the clean corpus and requires FFmpeg. The round trip exercises telephone bandwidth and codec loss; it does not add a real network, room noise, accent, packet loss, or a live caller. Run the real transcription adapter against this separate corpus with:

```sh
npm run eval:transcription -- --corpus transcription-telephony-v1 --out eval/results/transcription-telephony-candidate.json
```

The `--corpus` flag accepts `transcription-v1`, `transcription-telephony-v1`, `transcription-noise-v1`, and `transcription-safety-v1`. The same repeat, concurrency, digest, typed-result, and release-gate rules apply to all four.

`transcription-noise-v1.json` adds six patient-free clips from two Flite voices, `kal` and `slt`. `node scripts/build-noisy-transcription-fixtures.ts` mixes deterministic white noise at a nominal 10 dB signal-to-noise ratio before 8 kHz G.711 mu-law encoding and production media normalization. Each resulting 16 kHz fixture is pinned by SHA-256. Run it with `--corpus transcription-noise-v1`; use an owner-only output path and the same key handling as above. This is controlled synthetic interference, not representative clinic acoustics, accents, packet loss, or a real call. The [first live run](LIVE_BASELINE_2026-09-29.md#noisy-two-speaker-transcription-stress) had missing safety terms and leaves all finals `needsClarification`. Noisy results cannot promote natural-language caller actions.

`transcription-safety-v1.json` adds eight patient-free telephone-band clips with a seeded 20 dB noise mix from two generated voices. The cases cover clinic terminology, dates, spoken numbers, an email address, and currency. `node scripts/build-safety-transcription-fixtures.ts` regenerates and pins them. Run with `--corpus transcription-safety-v1`. Each `eval:transcription` report now includes the [versioned synthetic candidate gate](SPEECH_QUALITY_GATE.md): zero critical, provider, empty, and truncated results; word error rate no more than 10%; and bounded post-commit final latency across at least three repeats per case. A failing gate exits nonzero after saving its owner-only report. Older corpora use the same per-corpus gate for comparison; all required corpora must pass before a synthetic candidate can pass.

The Realtime runner also accepts `--model gpt-transcribe` for OpenAI's committed-turn transcription candidate. The production adapter still defaults to `gpt-live-transcribe`; the candidate uses the same bounded frame replay, item-ID matching, and untrusted final quality. Its [live synthetic comparison](LIVE_BASELINE_2026-09-29.md#realtime-committed-turn-transcription-comparison) is evaluation evidence, not a quality-gate change.

For a bounded comparison with OpenAI's file transcription endpoint, run `npm run eval:file-transcription -- --out eval/results/file-transcription-noise.json`. This converts only the pinned synthetic PCM fixtures to 16 kHz WAV in memory and uses `gpt-transcribe` by default. `--model gpt-4o-transcribe` selects the second supported candidate; `--corpus`, `--repeats`, and `--concurrency` have the same bounded options as the realtime runner. The owner-only report records exact words, missing critical terms, response time, corpus and runner hashes, and an unverified release gate. File transcription is an offline comparison, not the live call adapter; its results cannot promote a caller turn to `clear`.

## Signed local live speech evaluation

`test/live/signed-openai-voice.test.ts` is an opt-in integration test for a standalone greeting, one caller turn, and clinic-approved keypad recovery. It starts an isolated PostgreSQL database, signs synthetic Twilio webhook and WebSocket messages, calls the real OpenAI Speech and Realtime transcription APIs, sends a patient-free Flite clip through G.711 media, and checks non-silent outbound media and three returned local completion marks. The real transcript remains `needsClarification`, so the composed call speaks the approved clarification without querying an intent model or Cliniko. After that mark, keypad 2 reads a fake Cliniko availability response for tomorrow and speaks only provisional times. The test scans the database for the synthetic caller number, provider call ID, appointment ID, and appointment time. It needs FFmpeg to generate the inbound G.711 clip and uses no real Cliniko patient data or telephone number. With `ABBY_OPENAI_API_KEY` in the process environment, run:

```sh
work run "Abby signed local live speech evaluation" -- bash scripts/with-postgres.sh env ABBY_LIVE_VOICE_EVAL=1 node --test test/live/signed-openai-voice.test.ts
work wait "Abby signed local live speech evaluation"
```

The test is excluded from `npm test` because it makes paid provider calls. A locally returned mark is only synthetic transport evidence; this run does not prove that a real caller heard any response, that Twilio accepted the media, or that the pilot latency and voice-quality gates pass. A separate transcription quality gate is required before natural-language availability can use the Realtime final text. Keypad availability requires a clinic-approved greeting and remains unavailable by default.

## First-chunk speech fallback timing

`eval:speech-fallback` sends the two fixed patient-free phrases from `speech-loop-v1.json` through the real OpenAI synthesis models and Abby's `FirstChunkFallbackSpeech` plus `StreamedPlaybackPort`. It uses a 1.5-second primary selection bound, a 5-second combined first-chunk bound, and the usual 2-second later-step bound. The output port counts chunks and captures the time of the first queued chunk without saving audio. Run with `ABBY_OPENAI_API_KEY` available:

```sh
npm run eval:speech-fallback -- --out eval/results/speech-fallback-candidate.json
```

The default is twenty repeats per phrase with two concurrent jobs; `--repeats` accepts 1–20 and `--concurrency` accepts 1–4. The owner-only report records the selected source, queue outcome, first-chunk time, complete-utterance time, and source and corpus hashes for every job. The [synthetic latency gate](SPEECH_QUALITY_GATE.md) requires all forty jobs to queue, p95 first chunk at most 3.5 seconds, no individual first chunk over 5 seconds, and p95 utterance completion at most 6 seconds. It counts failures separately from the successful-job p95 and exits nonzero on any failed condition. This is provider and in-memory output evidence, not a caller's first audible speech or playback acknowledgment. Human review and a real call remain separate gates.

After running the telephone-band, noisy, safety, and first-chunk evaluations with the same candidate configuration, run `npm run eval:speech-gate -- --telephony <report> --noise <report> --safety <report> --speech <report>`. It rejects stale report hashes and prints a concise candidate verdict without transcripts. The [representative call gate](SPEECH_QUALITY_GATE.md#representative-call-gate) remains required even if every synthetic check passes.

## Speech loopback smoke evaluation

`speech-loop-v1.json` pins two patient-free messages: the AI disclosure and a provisional availability notice. The opt-in runner uses Abby's production `gpt-4o-mini-tts`/`coral` speech adapter, keeps its 16 kHz PCM output in memory, then replays it through Abby's production `gpt-live-transcribe` adapter. It rejects silent or malformed audio and flags missing safety words in the final transcript. Run with the key available in the process environment:

```sh
npm run eval:speech-loop -- --out eval/results/speech-loop-candidate.json
```

The default is two independently synthesized repeats per case and two concurrent jobs. `--speech-model` and `--voice` select a candidate; the defaults are `gpt-4o-mini-tts` and `coral`. The owner-only report records model IDs, corpus and source hashes, first-chunk and total latency, audio size and peak sample, final transcript, and typed verdict. It stores no audio or key. A matching loopback is a pipeline smoke test, not proof of caller comprehension or phone-line quality; human listening and representative calls remain separate gates. [The first live baseline](LIVE_BASELINE_2026-09-29.md#speech-synthesis-and-transcription-loopback) records both successful transcripts and synthesis timeouts. OpenAI's [speech guide](https://developers.openai.com/api/docs/guides/text-to-speech) documents the PCM streaming mode used by the adapter.
