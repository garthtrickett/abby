# Live synthetic evaluation baseline — 2026-09-29

All runs used patient-free synthetic fixtures, an account-provided OpenAI API key, and owner-only reports under ignored `eval/results/`. No key value or real patient content is in this file. The reports retain repeat-level proposals or transcripts for local review; this summary records only counts and configuration evidence.

| Run | Model | Corpus and repeats | Match | Mismatch | Critical | Provider failure |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Model prompt v1 baseline | `gpt-6-luna` | `model-v1`, 10 cases × 3 | 24 | 0 | 3 | 3 |
| Model prompt v2 candidate | `gpt-6-luna` | `model-v1`, 10 cases × 3 | 30 | 0 | 0 | 0 |
| Availability intent v1 baseline | `gpt-6-luna` | `availability-intent-v1`, 18 cases × 3 | 44 | 0 | 0 | 10 |
| Availability intent v2 candidate | `gpt-6-luna` | `availability-intent-v1`, 18 cases × 3 | 54 | 0 | 0 | 0 |
| Realtime transcription | `gpt-live-transcribe` | `transcription-v1`, 3 audio fixtures × 3 | 9 | 0 | 0 | 0 |

The model baseline failed booking intent three times because the model supplied `next week` in `requestedTime`, which the typed boundary correctly rejects as lacking an absolute instant. It also proposed appointment lookup three times for a shared-phone request where patient identification must come first. `prompt-v2` explicitly leaves relative times unresolved and routes another person's appointment request to patient lookup or handoff. The unchanged corpus passed all 30 repeat-level checks with that version.

The model v2 run was repeated after the runner began loading the file named by `--prompt-version`; the second 30/30 run used that default path and the source hash below.

The availability baseline classified undated, ambiguous, and past requests as availability with unusable dates; the decoder correctly returned `intentUnavailable`. One mixed staff request also failed. `availability-intent-v2` explicitly treats those requests as unsupported, and the unchanged 18-case corpus passed all 54 checks. Both versions leave patient-specific actions and disclosure to the typed core and host verification boundary.

The transcription run used the normal `gpt-live-transcribe` adapter with three generated PCM clips paced in 20 ms frames. All nine final transcripts preserved the fixture expectations. Clean synthetic audio does not establish telephone, accent, background-noise, or real-caller performance. Its finals remain untrusted for caller actions.

Configuration hashes from the local reports:

| Candidate | Prompt SHA-256 | Corpus SHA-256 | Adapter SHA-256 |
| --- | --- | --- | --- |
| Model v2 | `15c893fbdd6ce1d885682e10571b43f7985ca4438155da9d36cc563639d15272` | `a6132d8f0457ac16eb9fc65fa83e47767b3f8a2e2eb8d1d96ee0bd33064e8a5a` | `95313b44de246ce997b6c895e9cc2a686c39bf3960e2f6e73a055ec581d977f2` |
| Availability v2 | In adapter source | `b20f103bf8f8b15c286fed2018195ea63969fe3fc3ccb0e5dc97eb90a9bd9c5b` | `1dafc0bac037bda70456d3a27d67a3602d1717676982a4f85df50cba2d3d7d70` |
| Transcription | None | `2d3fabc12d13699ffecc4017d64ba9cedc91373e001529abf135a6f311357905` | `4b0f51859cb1a9fa067ee60f91a0c31c22bd6f42d77d4aefb91c1ae529e3d0f1` |

These are synthetic, model-only and transcription-only results. Human review is pending, the voice and phone-call gates are unrun, and every report says `releaseGate: unverified`. No live clinic pilot or autonomous patient action is approved by these counts.
