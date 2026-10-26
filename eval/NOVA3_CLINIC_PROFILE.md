# Nova-3 denoising and clinic vocabulary comparison

The owner selected this comparison on 23 October 2026 before changing speech
providers. This is an optional synthetic experiment. It does not select a
transcription adapter in a serving host or qualify a live clinic.

## Fixed hypothesis and inputs

Compare Nova-3's existing unprocessed result with these separately labelled
profiles, using the original noisy corpus and assessor:

| Profile | Audio processing | Vocabulary |
| --- | --- | --- |
| `baseline` | Existing unprocessed PCM | None; historical result retained |
| `clinic-v1` | Same unprocessed PCM | Fixed public physiotherapy pack |
| `krisp-clinic-v1` | Krisp Voice Isolation, `VIVA-tel`, suppression 100 | Same fixed pack |
| `rnnoise-v02-clinic-v1` | Separately declared local RNNoise v0.2/default model, external evaluation harness | Same fixed pack |
| `deepfilter3-056-clinic-v1` | Separately declared synchronous DeepFilterNet3 v0.5.6 standard model, external evaluation harness | Same fixed pack |

The baseline's historical failure is not erased or rerun just to obtain a better
sample. Run one bounded cohort for each new profile: six noisy fixtures, three
repeats, concurrency two, eighteen attempts. Record every provider failure.
Do not tune terms, suppression, thresholds, text or fixture selection after
seeing the new answers. A further hypothesis needs its own declared experiment.

`eval/transcription-noise-v1.json` remains SHA256
`ec91091d0a6e7ff8766bf9a3209cd653fd13f291bf55745b20640f3766fd4ab2`.
Verify each original audio file against that manifest. Keep the evaluator and
assessor unchanged. Record the profile, source hashes, dictionary, source audio
hashes, model, padding policy and results in a new private report.

The dictionary in `scripts/lib/deepgram-clinic-vocabulary.ts` contains the
reference snapshot's entire existing physiotherapy pack plus its unconditional
`reschedule` term. This choice includes ordinary pack words such as `pain`; it
does not add failed-fixture phrases or booking verbs from expected answers.
No patient names, private clinic identity or live contact data are included.

## Reference and limits of the comparison

The supplied Karen snapshot at `/home/gust/code/karen-website-dev` applies
`backgroundSpeechDenoisingPlan.smartDenoisingPlan.enabled` in assistant overrides,
and supplies clinic keyterms to Deepgram. Its default transcriber configuration
names `nova-3-general`; this does not establish the provider selected by a live
clinic. Vocabulary sources are
`server/src/services/transcriber/profile/disciplinePacks.ts` and
`server/src/services/transient/variables/vapiConfigVariables.ts`.

Vapi documents [Krisp background speech denoising](https://docs.vapi.ai/documentation/assistants/conversation-behavior/background-speech-denoising).
This experiment uses the separately documented
[Krisp Voice Isolation API](https://sdk-docs.krisp.ai/docs/realtime-voice-isolation)
before Abby's existing Nova-3 port. It tests the same two-layer approach; it does
not establish equivalence to Vapi's internal model, version, routing or latency.
No Vapi runtime integration or production call is part of this experiment.

## Transport and timing

The evaluation-only wrapper accepts one synthetic session, generation one and
20 ms, mono PCM16 frames at 16 kHz. It reframes to Krisp's required 30 ms frames.
Only the last transport frame is zero-padded. Returned audio is restored to
exactly the input's frame boundaries and sample count before Nova-3 receives it;
transport-only padding is discarded. The evaluator's original last-20-ms-frame
padding remains as in the baseline. Original stored audio is never rewritten.

Audio is streamed during playback. Final latency includes outstanding denoising,
Krisp normal closure and Nova-3 finality, under one shared two-second flush
deadline. The existing total duration also includes authentication, connection
and playback. Do not pre-process a file and omit its denoising latency.

Require product-scoped short-lived `viva` session tokens using
[Krisp's authentication protocol](https://sdk-docs.krisp.ai/docs/authentication).
The master key is used only by the backend token request, never on WebSocket or
in a URL. Both credentials and raw provider errors stay out of reports. Wait for
`ready`; require complete 30 ms output frame accounting and normal close. Missing,
extra, malformed, interrupted, rejected or delayed output fails the attempt;
there is no unprocessed fallback or automatic retry.

Nova-3 uses repeated, encoded
[`keyterm` parameters](https://developers.deepgram.com/docs/keyterm), not legacy
weighted `keywords`, a comma-separated list or dynamic configuration messages.
The bounded optional vocabulary is copied at adapter construction. An omitted
vocabulary retains the original provider configuration.

## Gate and commands

Keep [the existing speech gate](SPEECH_QUALITY_GATE.md): zero missing critical
terms, zero provider failures, empty/truncated/delayed output, aggregate WER at
most 10%, final p95 at most 2,500 ms and every final at most 5,000 ms. A failed
noisy profile does not proceed to clean/safety qualification. A noisy pass still
needs those separate original corpora and later representative call acceptance.

After local protocol and strict-type checks, run with the existing private Abby
Deepgram key. The two-layer profile additionally requires `ABBY_KRISP_API_KEY`.
Load only the required named secrets from the private environment; never paste
them into shell command arguments, version control or reports.

```sh
node scripts/evaluate-deepgram-transcription.ts --profile clinic-v1 --out /private/new-vocabulary-report.json
node scripts/evaluate-deepgram-transcription.ts --profile krisp-clinic-v1 --out /private/new-two-layer-report.json
```

Use tracked bounded jobs with fresh shared-compute admission. Each report is a
new exclusive mode-0600 file. A missing Krisp key means the full two-layer test
has not run; vocabulary-only results cannot stand in for it.

## Vocabulary component result, 23 October 2026

The [fixed vocabulary-only cohort](baselines/deepgram-clinic-vocabulary-noise-20261023-v1.json)
completed all eighteen recognitions: nine exact matches, three ordinary
mismatches and six critical failures. WER was 18.18% and final p95 was 208 ms,
with zero provider failures, empty, truncated or delayed results. All three
NS-005 attempts and all three NS-006 attempts remain critical. The historical
unprocessed baseline had 20.45% WER and the same six critical failures. These
separate cohorts do not establish a statistically significant improvement.
The vocabulary component fails the unchanged gate; no clean/safety follow-on or
runtime selection follows. It does not answer the denoising hypothesis.

The current local graph passes 54 focused source checks without skips and the
whole-project strict TypeScript check. These are offline engineering results.
The Krisp-backed two-layer comparison has not run: no Abby Krisp project key
has been supplied. The owner asked about proprietary versus self-hosted models;
A separately declared RNNoise comparison is recorded below; DeepFilterNet
was measured in the later comparison below. Neither substitutes for this declared Krisp profile. No
provider default is changed.

The follow-up direct composition cohort passes 57/57 focused tests, including
actual Nova-3 adapter finality after denoising, short-summary refusal and bounded
token acquisition. Its affected strict TypeScript check passes. The earlier
whole-project strict check and 54-test graph retain their original input scope;
no further provider requests were made for this follow-up.


## Separate RNNoise comparison, 24 October 2026

The [RNNoise v0.2/default-model aggregate](baselines/deepgram-rnnoise-clinic-noise-20261024-v1.json)
records one separately declared external evaluation with unchanged Nova-3 and
the same public vocabulary. All eighteen original noisy attempts completed:
six matches, six ordinary mismatches, six critical failures and zero provider
failures. WER was 38.64% and final p95 was 388 ms; empty, truncated and delayed
results were zero. The unchanged gate fails critical terms and WER. No
clean/safety follow-on or serving selection follows.

All three NS-001 and all three NS-006 attempts were critical. NS-005 had ordinary
mismatches. These are different failed cases from the vocabulary-only cohort,
which had nine matches, three ordinary mismatches, six critical failures,
18.18% WER and 208 ms final p95. These separate cohorts do not establish a
statistically significant difference or equivalence to Krisp or Vapi.

Pinned FFmpeg resampling streamed 16 kHz input to 48 kHz, the default RNNoise
model processed 480-sample frames, and output returned to 16 kHz during measured
playback. One declared model-only 10 ms zero tail compensates the upstream
example's priming-frame suppression. Input and forwarded-output counts were both 2,679 evaluation frames,
including the unchanged final 20 ms padding. Denoising, tail,
closure and owned-child reaping remained inside measured timing. Stored source
PCM was not overwritten; preprocessing time was not excluded.

The initial offline run remains failed at 8/11. In the Node socket setup,
reopening stdin through the file-oriented driver returned ENXIO; that run also
recorded SIGSEGV. A transport-only successor uses C standard stdin/stdout
handles and complete I/O without changing the default model, algorithm, frame
calculation or thresholds. The same eleven offline assertions then passed;
three actual Nova-3 adapter/fake-provider finality cases passed separately.
Those controls qualify transport, not acoustic quality. Independent original
assessor recomputation and 92 frozen inputs verify the eighteen measured
results. The provider scope peaked at 236,888,064 bytes under a 512 MiB cap,
with no OOM events and all owned children reaped.

This harness is an external evaluation artifact, not a new supported CLI or
serving profile. The declared Krisp comparison remains unrun for the known
missing project developer key. RNNoise's result does not answer that test or
change any production default, full-call evidence or activation decision.


## Separate synchronous DeepFilterNet3 comparison, 26 October 2026

The [patient-free aggregate](baselines/deepgram-deepfilter-clinic-noise-20261026-v1.json)
records one declared external cohort with the original six noisy fixtures,
three repeats, concurrency two, unchanged Nova-3 and the same public vocabulary.
All eighteen attempts completed: six matches, nine ordinary mismatches, three
critical results and zero provider failures. WER was **20.45%** and final p95
was **333 ms**; empty, truncated and delayed results were zero. All three
NS-006 attempts remain critical. The unchanged gate fails critical terms and WER;
this profile does not proceed to clean or safety qualification.

The earlier vocabulary-only cohort had six critical results, 18.18% WER and
208 ms final p95. These are separate eighteen-attempt observations and establish
no statistical significance, general improvement or equivalence to Krisp/Vapi.
The selected Krisp experiment remains unrun for its known missing developer key.

The harness uses the standard `DeepFilterNet3_onnx.tar.gz` model and synchronous
C API from upstream v0.5.6 commit `978576aa8400552a4ce9730838c635aa30db5e61`.
This is distinct from the larger low-latency model in the upstream LADSPA plugin.
Four initial plugin alignment probes remain failed: zero attenuation bypassed
model synthesis, and full-DSP probes changed buffering under one CPU, two CPUs
and 100 ms host blocks. Their results were not relabelled as this cohort.

Pinned FFmpeg resampling streams 16 kHz PCM to 48 kHz and back. The synchronous
standard model uses 480-sample hops, a 960-sample FFT and two-hop lookahead.
Three initial hops are compensated with three model-only tail hops, retaining
exactly the original evaluation frame count and its existing final-frame padding.
A declared signed 16-unit DC addition on near-silent PCM16 hops avoids the
upstream low-RMS early return freezing analysis/synthesis state. Full attenuation
is 100 dB, postfilter is disabled, and native thresholds stay at -10/30/20 dB.
These conditions were fixed before any provider answer. Stored input PCM was
never rewritten. Processing, tail, closure and child reaping stay within measured
playback and the original shared two-second flush deadline.

Seventeen offline controls passed with no skips. They include actual-library
streaming and single-frame accounting, quiet-gap timing calibration, concurrent
input refusal, malformed/missing/stalled child output, abort and fake Nova-3
complete/short/missing-close finality. The 0.1 dB calibration exercises full DSP;
relative RMS errors were 1.145% and 1.158% across its two fixed timing controls.
The provider cohort uses 100 dB attenuation. Independent recomputation verifies
all eighteen text verdicts, the original assessor result, all 32 frozen inputs,
all 2,679 input/forwarded frames and all eighteen native hop accounts. All owned
children are reaped. The provider scope peaked at 234,528,768 bytes under its
1 GiB/CPU200%/Swap0 budget, with no OOM events.

This remains an external evaluation artifact; the repository CLI and serving
profiles gain no DeepFilterNet selection. Production defaults, full-call evidence,
clinic/provider acceptance and activation requirements remain unchanged.
