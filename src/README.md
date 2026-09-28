# Text reference runtime

`core/transition.ts` is a pure state transition. `core/ledger.ts` provides a versioned store contract and an in-memory implementation. `core/runtime.ts` is the entry point for final caller turns, presentation results, and typed effect results. `reference/effect-worker.ts` runs host effects only after persisting the possibly-sent state. The worker treats a write transport error as uncertain and creates a reconciliation intent; a task transport error routes its item to operator review.

Run `npm ci` and `npm test`. Test files run in parallel with isolated calls and host fixtures. A new feature, capability, or setting needs a text contract case that checks caller wording, state, effects, and failure behavior. Its real voice path also needs a full-call E2E case when that path exists.

This composition does not call Cliniko or Splose. Its host is synthetic. The ledger is in memory, and a synthetic `played` result is only test evidence for downstream confirmation logic. No production caller, agent, or API can use this harness to assert playback. Persistence, real host adapters, media, and voice E2E remain open work.
