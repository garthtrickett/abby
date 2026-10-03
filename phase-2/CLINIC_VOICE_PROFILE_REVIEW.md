# Clinic locale and voice maintainability review

**Reviewed source:** `c39baf07d316bb76b16494e417b4212a7a1d7432..8e9ad1413281d4ead449751f5ae91136d80771d5`.
**Method:** thermo-nuclear-code-quality-review, applied directly without additional agents.
**Date:** 2026-10-03.

## Result

No substantive maintainability finding remains in the reviewed changes. This is a source review; the [feature contract](CLINIC_VOICE_PROFILE.md) records executable evidence and remaining release gates separately. It does not prove production authentication, real provider quality, a carrier call, or live clinic readiness.

## Boundaries inspected

| Area | Inspection and conclusion |
| --- | --- |
| Core contract | `voice-profile.ts` owns public preference/profile shapes and strict validation. `voice-profile-registry.ts` owns bounded asynchronous host resolution, detached captures and approval. Clinical permissions stay in their existing layers. |
| Preference storage | Memory and PostgreSQL implement one clinic CAS and targeted audit. The shared executable contract covers both implementations. PostgreSQL rechecks the exact preflight preferences under its version-zero row lock; independent location policy versions are preserved. |
| Policy composition | `captureVoicePolicy` discards injected location/default speech authority. Both stores capture the original authorized location before an asynchronous edit and return that scoped policy. Legacy persisted profiles are rejected rather than becoming host authority. |
| Provider construction | `OpenAIVoiceProfileHost` supplies catalogue and actual adapters from one physical descriptor. `CallSpeechBinding` owns one detached profile and provider lifecycle. Unknown, stale and mismatched configurations deny construction; ordinary preference edits do not replace an active binding. |
| Routing and shutdown | Candidate location reads run concurrently and must agree before shared-number speech. `closeUnattachedCall` centralizes reservation cleanup. The bounded terminal CAS retry rechecks ownership and retries no clinical effect. |
| Frontend | One 169-line lit-html control serves both dashboards. Compatible choices, targeted clears, mutation lock and scoped reread recovery remain in that control rather than being duplicated in the two compositions. HTTP/gateway authorization remains independent of UI visibility. |
| Portability | `voice-history.ts` is the canonical targeted history/target-clear model. PostgreSQL carryover uses that model inside the existing import transaction. Freeze guards, occupied-target checks, exact target reconciliation and total counts include the new history. Executable profiles are excluded from archives. |
| Tests | New settings have storage, command/HTTP, browser and complete synthetic call evidence. Existing fixture changes explicitly supply approved synthetic profiles; production readiness defaults remain unproven. Old capability-menu expectations now enumerate the four new commands while retaining clinical-command denial. |

## Structural checks

- No changed production file crosses 1,000 lines. The dashboard controller grows from 958 to 964 lines; the control logic is extracted into its own module.
- The two already large changed test files grow by one line each: `test/browser/dashboard.spec.ts` from 1,093 to 1,094, and `test/voice/voice.test.ts` from 2,052 to 2,053. The new feature scenarios live in separate files.
- Generated table types are actual Kanel/kanel-kysely output. Domain types describe the portable contract; database brands are applied at the storage boundary.
- Runtime/provider configuration, raw clinic preferences and portable history have distinct owners. No generic settings framework or new dependency is introduced for this feature.
- Exact-shape checks and boundary casts validate untrusted host, HTTP or archive data. They do not bypass clinic scope, CAS, profile coherence or target readiness checks.

Inspection used the complete branch diff and changed-file line counts, followed by direct reads of the new contract, storage, registry, binding, UI and carryover modules and their integration diffs. Focused evidence is recorded in the feature contract; the final mapped parallel release was still running when this review was written.

## Changes justified during implementation

The feature contract preserves the diagnostic history: exact clinic versus location scope was corrected in the control; authorized scope was captured across async preflight; terminal close conflicts gained a bounded ownership-preserving retry; and old synthetic fixtures and command-menu assertions were updated. These are implemented corrections with executable regressions, not unresolved review findings.

Potential future consolidation of older dashboard orchestration or settings import machinery is outside this feature. No concrete simplification was identified that would justify rewriting those contracts here.
