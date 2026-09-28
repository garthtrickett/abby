# Phase 0 working set

The [execution plan](../PHASE_0_EXECUTION_PLAN.md) is the gate. These files are evidence and proposed decisions in progress; none is a Phase 0 sign-off.

| Package | Current state | Evidence or next step |
| --- | --- | --- |
| P0-01 call evidence | Source-flow inventory drafted; real-call corpus incomplete | [Call cases](CALL_CASES.md). Select de-identified calls and confirm source policy with clinic owners. |
| P0-02 product decisions | Proposed defaults; none approved | [Decision register](DECISIONS.md). Record product and clinic answers before dependent behavior is built. |
| P0-03 Cliniko | Documentation and read-only demo probe recorded; no mutation approved | [Cliniko evidence](CLINIKO_EVIDENCE.md). The demo business is not enabled for online bookings, so offer proof needs an eligible test setup. |
| P0-04 Splose | Unverified; no account available | [Draft support matrix](SUPPORT_MATRIX.md). Keep every Splose claim unverified until an account/profile can be probed. |
| P0-05 media and fallback | Deferred during the text-first checkpoint; provider/account not selected | The [text test plan](TEXT_TEST_PLAN.md) advances call/action contracts. Playback, transfer, and fallback remain required before full Phase 0 sign-off or live-call readiness. |
| P0-06 to P0-10 | TXT-01 through TXT-09 run against memory and disposable PostgreSQL; a [reference host composition](REFERENCE_HOST_CONTRACT.md) exercises booking, one setting, and staff fallback in standalone and embedded forms | Run `npm test` and `npm run probe:postgres`. The production ledger, final contracts, and full-call E2E remain open. |

The Cliniko [read-only probe](probes/cliniko_readonly.py) prompts for its key in a terminal. Credentials and provider response records are not committed. A 200 GET proves only that this key can perform that read; it does not prove safe automation or write permission.
