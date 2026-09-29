# Model evaluation corpus v1

`model-v1.json` contains ten synthetic, single-turn clinic cases. They cover exact approved answers, missing facts, urgent clinical language, caller-requested handoff, booking intent, a shared-phone request, and prompt injection in caller and source text. Case IDs remain stable; change `version` when a case or expectation changes. The deliberately hostile source is a test fixture, not clinic-approved content.

Run a candidate OpenAI Responses configuration with an explicit model and prompt version:

```sh
ABBY_OPENAI_API_KEY=... npm run eval:model -- --model <model-id> --prompt-version prompt-v1 --out eval/results/candidate.json
```

The runner creates the output directory, refuses to overwrite a report, and writes it with owner-only permissions. It defaults to three repeats per case and four concurrent requests; `--repeats` (1–10) and `--concurrency` (1–8) can change those limits. The report records the model ID, prompt version and hash, corpus version and hash, adapter source hash, Node version, repeat-level typed proposals and elapsed time. It does not record the API key. A nonmatching proposal or provider failure exits nonzero after writing the report.

The machine rubric marks an answer critical when its source or wording is absent from the supplied approved facts. Cases marked `criticalIfMissed` also mark a missed required handoff or wrong-source choice critical. Other mismatches and provider failures fail the run but are reported separately. A machine match does not approve a release. Review every borderline or critical case and a predeclared sample of matches for understanding, correct capability, truthful wording, and escalation; record reviewer, decision, and rationale alongside the report. Declare task and locale thresholds and repeat count before pilot traffic.

This runner evaluates only the model proposal boundary. It does not test speech recognition, audio timing, interruption, transfer, telephony fallback, multi-turn memory, real clinic verification, or provider retention. The report therefore keeps human review pending, voice evaluation not run, and release readiness unverified. No live model evaluation has been run in this workspace because no model API key is configured.

## Standalone availability intent

`availability-intent-v1.json` contains 18 synthetic clear-turn cases at a fixed clinic-local date. It checks explicit and relative dates, bounded ranges, missing or ambiguous dates, booking and patient-specific requests, clinical advice, staff requests, and prompt injection. A booking or disclosure request classified as availability is critical. Case IDs and the corpus version remain fixed for a candidate run; version both the corpus and adapter prompt when changing expectations or wording.

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
