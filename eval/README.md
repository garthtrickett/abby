# Model evaluation corpus v1

`model-v1.json` contains ten synthetic, single-turn clinic cases. They cover exact approved answers, missing facts, urgent clinical language, caller-requested handoff, booking intent, a shared-phone request, and prompt injection in caller and source text. Case IDs remain stable; change `version` when a case or expectation changes. The deliberately hostile source is a test fixture, not clinic-approved content.

Run a candidate OpenAI Responses configuration with an explicit model and prompt version:

```sh
ABBY_OPENAI_API_KEY=... npm run eval:model -- --model <model-id> --prompt-version prompt-v1 --out eval/results/candidate.json
```

The runner creates the output directory, refuses to overwrite a report, and writes it with owner-only permissions. It defaults to three repeats per case and four concurrent requests; `--repeats` (1–10) and `--concurrency` (1–8) can change those limits. The report records the model ID, prompt version and hash, corpus version and hash, adapter source hash, Node version, repeat-level typed proposals and elapsed time. It does not record the API key. A nonmatching proposal or provider failure exits nonzero after writing the report.

The machine rubric marks an answer critical when its source or wording is absent from the supplied approved facts. Cases marked `criticalIfMissed` also mark a missed required handoff or wrong-source choice critical. Other mismatches and provider failures fail the run but are reported separately. A machine match does not approve a release. Review every borderline or critical case and a predeclared sample of matches for understanding, correct capability, truthful wording, and escalation; record reviewer, decision, and rationale alongside the report. Declare task and locale thresholds and repeat count before pilot traffic.

This runner evaluates only the model proposal boundary. It does not test speech recognition, audio timing, interruption, transfer, telephony fallback, multi-turn memory, real clinic verification, or provider retention. The report therefore keeps human review pending, voice evaluation not run, and release readiness unverified. No live model evaluation has been run in this workspace because no model API key is configured.
