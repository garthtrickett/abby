# Speech quality and latency gate, version 1

This gate rejects weak voice configurations before a pilot. Passing its synthetic checks never grants caller-action or clinic readiness. The current standalone route keeps Realtime finals at `needsClarification`, and keypad availability remains the bounded recovery path.

## Synthetic candidate checks

Run the exact candidate Realtime adapter and model three times per case on each pinned corpus: telephone-band clean speech, 10 dB noisy speech, and the eight-case safety corpus. The safety corpus adds two generated voices reading clinic terminology, a date, spoken numbers, an email address, and currency after 8 kHz G.711 and a seeded 20 dB noise mix. Every fixture is patient-free and SHA-256 pinned. The evaluation runner replays 20 ms frames at their recorded pace and retains only an owner-only report. Its final time starts when Abby commits the audio turn; total time also includes audio playback into the adapter.

For **each** corpus, the machine gate requires at least three repeats of every case, zero missing critical terms, zero provider failures, zero empty finals, zero likely truncated finals, word error rate at most **10%**, final-transcript p95 at most **2.5 seconds** after commit, and no individual final over **5 seconds**. Word error rate uses case-insensitive word tokens and treats alternate numeric spellings as errors until a reviewed normalization rule exists. A likely truncated final is a strict prefix missing at least two expected words. Empty, truncated, late, and provider-failed results are reported separately. These are conservative candidate thresholds, not measured real-caller performance targets.

Run the fixed two-message synthesis corpus for **20 distinct repeats per message**, 40 jobs total, with at most four concurrent provider calls. Missing, duplicate, or foreign case/repeat pairs fail the gate. All jobs must queue audio; first queued chunk p95 must be at most **3.5 seconds**, every first queued chunk at most **5 seconds**, and full-utterance p95 at most **6 seconds**. Failed or uncertain jobs count against the gate even if the p95 of successful jobs passes. Queue timing is not audible playback timing.

`npm run eval:speech-gate -- --telephony <report> --noise <report> --safety <report> --speech <report>` recomputes all four checks from owner-only reports. It verifies the pinned corpus and current adapter source hashes, rejects stale reports, prints only aggregate metrics, and exits nonzero if any check fails. It always reports `releaseGate: unverified`.

To make the latest validated set available to an owner-run operations check, add `--record-current eval/results/current-speech-gate.json` to that assessment command. The assessor atomically records absolute paths to all four reports in an owner-only (0600) local file after validating source and corpus hashes, even when a quality threshold fails. It does not record an invalid or stale set. `npm run voice:ops:speech` rereads that set and the four owner-only reports, recomputes the aggregate checks against the current source and pinned corpora, and emits only status, failure codes and aggregate metrics. It exits `0` for a passing synthetic candidate, `2` for validated reports with a failing threshold, and `1` with a fixed error and no metrics when a report is missing, stale, invalid, or not owner-only. Set `ABBY_SPEECH_GATE_REPORT_SET` to an absolute path when the local set is stored elsewhere. The set and reports are ignored local evaluation artifacts, not database rows; the owner-token local dashboard projects only fixed aggregate check names and states. This command does not run the evaluations, schedule them, grant caller-action authority, or change `representativeCallGate: notRun` and `releaseGate: unverified`.

For the separate `tts-1` primary latency candidate, pass `--speech-profile tts-1-primary-v1` with a report produced by `npm run eval:speech-fallback -- --primary-model tts-1 --fallback-model tts-1 --primary-first-chunk-ms 2500 --repeats 20 --concurrency 4 --out <owner-only-report>`. The assessor pins those exact models, voice, deadlines, corpus, source hash and job count; the numerical thresholds above do not change. Omit `--speech-profile` to assess the default `gpt-4o-mini-tts` primary / `tts-1` fallback profile. Selecting a speech profile does not change the standalone voice runner.


## Source-matched speech checkpoint, 23 October 2026

The [aggregate evidence](baselines/synthetic-speech-current-20261023-v1.json)
records the current transcription adapter and unchanged pinned corpora. Three
repeats per case at provider concurrency two completed all 51 recognitions:

| Declared default `gpt-live-transcribe` corpus | Runs | Critical runs | WER | Final p95 | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| Clean telephone | 9 | 0 | 0% | 712 ms | Pass |
| 10 dB noise | 18 | 12 | 40.91% | 1,252 ms | Fail |
| Safety | 24 | 11 | 26.11% | 871 ms | Fail |

No provider, empty, truncated or delayed result was reported. Accuracy still
fails the original zero-critical and at-most-10% WER limits. Timing alone does
not pass this gate.

One predeclared alternative used the existing committed-turn `gpt-transcribe`
model with static `clinic-v1` context on all six original noisy clips at three
repeats. All 18 recognitions completed: four critical runs, 13.64% WER and
1,142 ms final p95. It also fails. Actual errors include a booking request
becoming rescheduling and chest pain becoming fast pain or fasting. These
cannot be normalized into success. The alternative has no new clean, safety
or representative-call qualification and is not selected for the runtime.

The four-input assessor validates the three new transcription reports and the
original October 1 synthesis report against their current source/corpus hashes.
That retained synthesis evidence passes its original 40-job limits; it is not
a fresh synthesis run or a current backend latency guarantee. The assessor
exits 1 for quality failure and the owner status reader exits 2, rather than
reporting missing or stale inputs. A private report set holds this assessment;
the historical default set is unchanged.

No fixture, threshold, prompt in the default profile, production model, audio
transform or caller-action quality changed. Realtime finals remain
`needsClarification`, `representativeCallGate` is `notRun`, and `releaseGate`
is `unverified`. Any other provider remains an unselected experiment requiring
its own exact configuration and qualification. Synthetic results do not close
the representative acoustic or clinic/provider acceptance gates below.

## Representative call gate

Before any patient call or natural-language availability is enabled, record a consented, patient-free evaluation over the intended carrier and clinic acoustic route. Predeclare at least **100 complete calls** from at least **10 speakers**, covering each intended locale and varied accents, quiet and noisy rooms, interruptions, numbers, dates, email, currency, clinic names, urgent language, and long turns. Keep source audio and review notes in a restricted evaluation store outside Abby's patient database. Compare final transcripts with human-labeled words and review all critical errors plus a predeclared sample of other calls.

The proposed pilot threshold is zero missed urgent or booking safety terms, zero false booking confirmations or patient disclosures, at most **10%** word error rate overall and per target locale, final-transcript p95 at most **2.5 seconds** after caller turn end, first *audible* response p95 at most **5 seconds**, and interruption-to-silence p95 at most **300 ms**. Report empty, truncated, delayed, dropped, and failed turns separately. A clinic owner and product owner must approve the wording, policy, and recorded result before routing patient calls. A synthetic pass cannot substitute for this representative gate.

The thresholds and case mix are Abby's predeclared engineering targets. [OpenAI's Realtime transcription production checklist](https://developers.openai.com/api/docs/guides/realtime-transcription#production-checklist) calls for representative telephony audio, target latency and accuracy thresholds, numbers and domain terms, separate tracking of empty/truncated/delayed results, and item-ID reconciliation. It does not supply Abby's numerical thresholds.
