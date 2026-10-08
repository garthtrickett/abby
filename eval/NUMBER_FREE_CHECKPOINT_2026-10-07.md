# Number-free checkpoint — 2026-10-07 (completed 2026-10-08)

This checkpoint follows the eighteen completed [second call-batch families](SECOND_CALL_BATCH_PLAN.md). The owner deferred a Twilio number and real email, and explicitly selected synthetic audio for continued speech investigation. No patient recording or patient detail was used. [Aggregate evidence and artifact hashes](baselines/number-free-checkpoint-20261007-v1.json) retain the exact results and limitations.

## Fresh conversation evaluation

On `main` at `42701b5e7cc0cb2459ef112b418a6a76f46bb060`:

```sh
node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinic-conversations.ts --model gpt-4o-mini --out eval/results/20261007-next-all45-v24.json
```

All 45 cases executed, with zero setup gaps, harness failures or failed observations. The 45 named conversation observations and 135 safety checks passed. The run made six candidate model requests; 39 cases used trusted interpretation paths. Prompt version is `clinical-intent-v24`; privacy and source-stability checks passed. The source fingerprint is `142bd3cffa440973185f298a736ed9d7bdb5185040bedd0b5b2391a8a14aef01` across 485 files. The original 45-case corpus was unchanged.

After the test-fixture corrections on 8 October, the same command ran against the corrected worktree with a separate owner-only output, `eval/results/20261008-corrected-all45-v24.json`. It again passed all 45 observations and 135 safety checks, with six candidate model requests and 39 trusted paths. Source stability and privacy passed; its 485-file source fingerprint is `c763db58d51c538929af96f5173938c9bfb5e54a42bb4ed73df9a781e1416c29`. The prior main report remains unchanged.

This evaluates the named workflow observation in each case. It does not assess every prose acceptance clause, establish model reliability, exercise speech, or prove live clinic/carrier readiness. The ignored, owner-only report preserves its `partial-baseline-not-a-release-gate` designation.

## Speech investigation

Each new screen uses one repeat per case and two concurrent provider sessions, with paced 20 ms replay through the actual Realtime adapter. Exact word and critical-term scoring, the three-repeat minimum, and latency thresholds are unchanged. One-repeat differences are diagnostic and do not rank models or prove improvements.

### Original pinned noisy corpus

All arms below use the same six clips. Except the null-noise-reduction comparison, they supply the same generic English physiotherapy context, with no expected sentence or case-specific hints.

| Candidate | Critical misses / 6 | WER | Post-commit final p95 | Result |
| --- | ---: | ---: | ---: | --- |
| Default `gpt-live-transcribe`, implicit noise setting | 4 | 43.18% | 819 ms | Fail |
| Same model, explicit `noise_reduction: null` | 4 | 40.91% | 860 ms | Fail |
| Fixed FFT filter, `gpt-live-transcribe` | 3 | 36.36% | 842 ms | Fail |
| Fixed FFT filter, `gpt-transcribe` | 2 | 15.91% | 893 ms | Fail |
| Fixed FFT filter, `gpt-4o-transcribe` | 2 | 34.09% | 9,493 ms | Fail; one late final |
| Native PCMU wire, `gpt-live-transcribe` | 1 | 29.55% | 1,104 ms | Fail; wire instrumentation incomplete |
| Native PCMU wire, `gpt-transcribe` | 2 | 20.45% | 767 ms | Fail; wire instrumentation incomplete |
| Audio-derived FFT noise floor, `gpt-transcribe` | 1 | 15.91% | 1,223 ms | Fail |
| Nonlocal means filter, `gpt-transcribe` | 1 | 18.18% | 10,627 ms | Fail; one late final |

There were zero provider failures, empty finals or prefix-truncated finals in these screens. Every arm fails both critical-term and word-error conditions, as well as the repeat minimum. The urgent-language clip `NS-006` still loses critical words in the promising filter screens, so no candidate was expanded to a complete promotion gate.

The null-setting comparison observed `noise_reduction: null` in both arms' actual provider acknowledgments. An explicit null therefore supplies no demonstrated configuration correction. The native PCMU screen omitted wire hashes because adapter teardown calls `terminate`, bypassing the shim's `close` hook. The original paid report is retained without repair; a separate offline check verified six exact original PCM round-trips through the proposed PCMU projection and the production media normalizer. That check proves the local transformation, not the remote sent bytes or speech quality.

Filters used the existing FFmpeg 6.1.1 installation. The fixed filter was `highpass=f=80,lowpass=f=3400,afftdn=nr=12:nf=-35:tn=1`. The adaptive variant estimated the noise floor from the tenth percentile of full-clip 20 ms RMS values, clamped to −60..−20 dB, with `tn=0`; it uses future audio and is not causal. The nonlocal variant used `anlmdn=s=0.002:p=0.002:r=0.006` after the same band limits. All preprocessing occurred before paced replay. None establishes a streaming implementation or its end-to-end delay.

### Supplemental booking and correction clips

Four ordinary phrases cover a Friday-afternoon booking, the nineteenth of October, half past three, and a correction from Tuesday morning to Thursday afternoon. Two additional Flite voices (`awb`, `rms`) each supply quiet and seeded nominal 10 dB white-noise versions, followed by G.711 encoding and the production media normalizer. Sixteen clips and their manifest are pinned in the owner-only local directory `eval/results/synthetic-booking-corrections-v1-complete/`.

That directory also contains sixteen WAV listening exports. Each wraps the exact pinned PCM without processing; `wav-exports.json` records their hashes. Human listening remains pending. The exports contain only the newly generated patient-free phrases.

The unchanged default, unprompted `gpt-live-transcribe` configuration gave:

| Condition | Clips | Exact matches | Critical misses | WER | Final p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Quiet | 8 | 8 | 0 | 0% | 823 ms |
| Noisy | 8 | 3 | 4 | 19.12% | 822 ms |

The remaining noisy result is a noncritical wording mismatch. There were no provider failures, empty, prefix-truncated or delayed finals; source remained stable. The quiet subset still lacks the three repeats required for a gate. The noisy losses include booking, date and time words, so the original two-voice noise finding also occurs with these added generated voices. This does not measure real speakers or clinic acoustics. Numeric spelling and all original exact token checks were retained.

An initial fixture-generation attempt failed before provider requests because commas in the correction sentence were parsed as FFmpeg filter separators. The corrected runner passes the unchanged phrase through an owner-only text file. Its failed log and partial fixtures remain separate from the completed corpus. Completed diagnostic commands and runner/report hashes are recorded in the evidence JSON. Supplemental results do not replace any original pinned gate corpus.

### Current admission decision

`node scripts/read-speech-gate-status.ts` still validates the existing complete source-matched report set and exits `2`: clean telephone speech and synthesis pass; noisy and safety transcription fail. The new screens do not overwrite that set. No adapter, prompt, production admission, dependency or threshold changed. All real Realtime finals remain `needsClarification`; `representativeCallGate` remains `notRun`, and `releaseGate` remains `unverified`.

## Full regression and fixture corrections

The initial complete text sweep ran 1,163 tests: 1,098 passed, one failed and 64 PostgreSQL-dependent cases skipped. Its sole failure was the composition test expecting five agent commands when production already exposes nine. The assertion now checks all nine in their existing order, retaining administrator denial and exact played-confirmation, affirmation, keyed host-write and single-send checks. No production code changed.

The focused composition check passed 11 tests, with three PostgreSQL-dependent skips, out of 14. The first catalogue-corrected regression ran sequentially:

```sh
npm run typecheck
npm run test:text
npm run probe:postgres
npm run test:browser
git diff --check
```

The tracked user-scope job is `Abby corrected full local regression October 7`; its log is `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791416491732.log`. Corrected typecheck passed. The complete text/voice pool passed 1,099 of 1,163 tests, with zero failures/cancellations and 64 PostgreSQL-dependent skips; the separate ordering coordinator passed one test without skips. The PostgreSQL pool then failed: 1,627 tests, 1,620 passed, five failures, one cancellation and one existing opt-in live-provider skip. Its ordering coordinator and browser checks did not run. The cancellation crash test exceeded its 90-second aggregate deadline; the budget-event assertion failed under a valid competing request order; three signed voice checks used stale model-fallback wording, including the PCM fixture tone mapping. The suite parent also reports the failed voice subtests.

A focused four-worker baseline run reproduced the budget assertion with actual SQL and deterministic availability-first scheduling. All six cancellation crash cases passed in that run in 54.4 seconds, so the broad-run timeout is not claimed as reproduced. Recovery workers unnecessarily imported both sender fixture graphs; their six measured startups took 989–3,249 ms. The correction loads those fixtures only for sends, retaining actual recall discovery and every crash checkpoint. 

The budget test now observes exact concrete claim denials, and the three voice model paths assert the current conservative fallback with a distinct synthetic PCM tone. Deadlines, worker counts, production behavior, stale-result suppression, one-send and privacy checks remain intact. Typecheck and all nine focused PostgreSQL checks passed, including the forced request order and all six cancellation crash checkpoints. 

The focused voice suite passed the three repaired model paths, then exposed E2E-204 expecting a total arrival order for two concurrent provider reads: 33 passed, one failed leaf plus its failed suite parent, out of 35. Its correction checks the exact business read and the exact two ordered validation stages, permitting either arrival order within each parallel pair. GET-only and zero available-times assertions remain. The corrected focused signed-voice suite passed all 35 tests with zero failures, cancellations or skips.

The final frozen-source job, `Abby final PostgreSQL and browser checkpoint October 8`, completed exit 0 in 31m55s; log `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791419558841.log`:

| Command | Final local result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run probe:postgres` | Migration round trip, upgrade probes and Kanel generation passed; pool 1,627 tests, 1,626 passed, zero failed/cancelled, one skipped; ordering coordinator one passed, no skips |
| `npm run test:browser` | 75 passed in 4.1 minutes; ordering coordinator one passed, zero failed/cancelled/skipped |
| `git diff --check` | Pass |

The PostgreSQL skip is C-LIVE-40, an existing opt-in real demo-provider patient-creation case. It is not counted as a pass. The pool includes all text/voice files plus storage, so the earlier passing text sweep was not repeated separately. Generated schema files are unchanged. The six-case cancellation crash check passed in 86,724.5 ms within its original 90,000 ms deadline; its 25,000 ms child deadlines are unchanged. This is an observed pass on this machine, not a performance guarantee for slower hosts. All five changed executable/test files match the recorded hashes; the final 485-file conversation fingerprint matches the corrected-source evaluation. No production code, dependency, scenario-manifest row, threshold or pinned gate corpus changed.

Exact temporary diagnostic runner bytes are retained owner-only under `eval/results/`, with hashes in the aggregate record. Their original absolute worktree paths are preserved for provenance. Publication uses the owner's existing normal merge authorization after passing local checks. GitHub execution status must be recorded separately; no CI pass is claimed. The setting-isolation sweep from the earlier checkpoint remains historical evidence; this checkpoint does not claim a fresh rerun of that separate sweep.

## Remaining work

Speech accuracy still fails the original declared synthetic gate. Continue only bounded synthetic investigations with preserved fixtures, source hashes and thresholds; a failed candidate does not justify deployment. Real email is owner-deferred. Twilio routing, carrier media/listening, real clinic policy and staff acceptance, and Splose remain separate unverified activation gates.
