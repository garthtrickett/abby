# Owning-host appointment write design

**Status:** executable PostgreSQL design proof for an authorized embedded host, not a standalone Cliniko implementation or release approval. The buyer must own the authoritative diary and every applicable write path. The [activation contract](CLINIKO_WRITE_ACTIVATION.md) remains authoritative for all five operations.

## 1. Decision and limits

Use an atomic final commit, rather than keeping a slot locked while a caller speaks. The owning diary rejects an overlapping interval when booking or moving an appointment. A move or cancellation also compares the exact confirmed target version in that same transaction. The action and exact receipt commit together in the authorized host's database. A rejected booking requires new alternatives and fresh presentation/affirmation; an offer is not a reserved or confirmed appointment.

This solves the appointment collision and outdated-target mechanisms **when the host owns the diary**. It cannot protect an external Cliniko HTTP write: Abby's transaction cannot lock Cliniko UI/API writers or commit a receipt atomically with Cliniko. Standalone retains only phone-to-patient-ID links. D-16 accepts a separate best-effort external Cliniko contract; all patient writes remain unavailable until its workflow, authority and operation proofs pass. The proof adds no production migration, runtime adapter, dependency or storage exception.

Cliniko's reviewed public appointment writes and unavailable-block writes do not establish conditional updates or atomic reservation consumption. Its online-booking help describes unavailable blocks as hiding offered times; that does not establish that all direct API/UI mutations reject overlap. [Official appointment API](https://github.com/redguava/cliniko-api/blob/main/sections/individual_appointments.md), [official help](https://help.cliniko.com/en/articles/8412082-help-my-appointments-aren-t-showing-up-in-online-bookings).

The appointment Markdown reference is in Cliniko's archived API repository; the current contract review used the dated official OpenAPI snapshot recorded in the activation contract. [A maintainer's 2015 response](https://github.com/redguava/cliniko-api/issues/108#issuecomment-157761727) explains why that API allowed overlaps and offered conflict inspection afterward. This historical evidence is not a current atomic-write guarantee or proof that no supported alternative exists; stronger provider protection remains optional research under D-16, while best-effort activation requires its declared workflow and authority proofs.

## 2. Invariants in the owning diary

| Invariant | Mechanism in the proof | Integration requirement |
| --- | --- | --- |
| One active individual appointment per resource interval | Immediate GiST exclusion over tenant, practitioner and `[starts_at, ends_at)` | Every UI, API, import, background and Abby writer uses the same protected authoritative occupancy. Direct ordinary SQL inserts are covered. Privileged constraint/trigger bypass is outside the application contract and must not be available to writer roles. |
| Practitioner cannot be booked twice at different locations | Business is absent from the exclusion key | Map every location's practitioner to its authoritative host resource identity. Tenant isolation does not promise coordination with another provider or independent tenant. |
| Actual intervals, not equal start strings | Timestamp range overlap; positive finite intervals; UTC instants | Include the host's complete occupancy duration and any required buffer/resource occupancy. Group capacity and multi-resource bookings are outside this individual-appointment proof and remain unsupported until separately designed. |
| Confirmed target is unchanged at mutation | Monotonic revision advanced by every update; conditional update includes tenant, patient, practitioner, business, type and expected revision | A prepared action binds the exact snapshot and approved terms. Changes to relevant related policy/fee/eligibility records must also invalidate or reject that action at commit. The simple fixture does not model those records. |
| An old identity/version cannot describe a replacement row | Immutable tenant/appointment keys and refusal of diary deletion/truncation in the fixture | The fixture retains inactive rows. A production host's approved retention/purge design must use non-reusable identity/generation tokens; deleting and recreating the same ID at revision 1 would invalidate this proof. Privileged maintenance needs its own controlled contract. |
| Failed move preserves original appointment | In-place update and exclusion enforcement inside a transaction/subtransaction | Never release the source through a separate cancellation or create a replacement appointment. |
| One exact owner attempt | Unique tenant/attempt receipt with server-built full operation binding; competing attempt readers wait for the same transaction | Host issues attempt identity. Production binding must also include the prepared action, policy, authority and confirmation versions. A model cannot supply proof or invent an attempt to bypass caller confirmation. |
| No committed mutation without its receipt | Mutation and receipt in the same database transaction | Patient-specific receipts belong to the authorized host, not standalone Abby. Configure durable commits and use the primary for recovery; deployment/failover recovery needs its own evidence. |

PostgreSQL documents [range exclusion constraints for non-overlapping reservations](https://www.postgresql.org/docs/17/rangetypes.html#RANGETYPES-CONSTRAINT) and [database constraints](https://www.postgresql.org/docs/17/ddl-constraints.html). The proof uses PostgreSQL 17 and its bundled `btree_gist` extension in a disposable schema. No extension is added to Abby's production migrations.

## 3. Existing host interface and transaction

The production adapter belongs behind the existing reception host interface, with the buyer's generated database types and query layer. The SQL fixture is a proof of commit mechanics, not another public agent command or proposed replacement for the core/SAM loop.

| Step | Inputs | Outputs and next call |
| --- | --- | --- |
| Prepare through existing host/core | Trusted caller scope, exact target/draft, policy and proposed interval | Exact prepared snapshot and presentation; no mutation or long-lived database lock. The core must finish playback and obtain separate caller affirmation. |
| Admit native commit | Captured prepared action, host-issued attempt, current actor/caller authority, policy/credential/write-stop versions | Refuse invalid/revoked/stopped or changed bindings. The host transaction must fence all relevant policy changes through commit, not check them only before starting it. |
| Acquire exact receipt ownership | Tenant/attempt and server-built complete request binding | Same binding and completed receipt returns the original result without mutation; different binding refuses reuse. Simultaneous owners wait for the one transaction. |
| Apply native operation | Authorized current bindings; for change, expected target revision; for booking/move, exact interval | Book inserts into constrained diary. Cancellation conditionally marks one occurrence inactive. Move conditionally changes that same row's interval. Constraints reject overlap, and changed target rejects the update. |
| Commit result and owned work | Mutation result and exact request | Receipt commits with mutation. Proven slot/target denial is recorded; an unexpected database failure rolls back the whole transaction. Any required fee/notification/work records must join the buyer's existing transactional ownership contract. The fixture does not implement notifications or staff delivery. |
| Report/recover through existing core | Exact receipt or unknown transport result, current scoped authority | Map proven success to the existing committed result; target/slot denial to a truthful failed proposal; unreadable or possibly sent result to uncertainty. A fresh owner reads the exact host receipt. No blind mutation retry or compensation follows a missing receipt. |

The reference function `commit_diary` in [the SQL fixture](../../test/support/owning-host-diary.sql) accepts operation, tenant/attempt, appointment/patient/practitioner/business/type IDs, expected revision and proposed interval. It returns an exact committed snapshot or a fixed `targetChanged`, `slotUnavailable`, `requestMismatch` or `invalidRequest` result. These fixture results are not new core error variants. The actual adapter must map them into the existing typed Result/effect contract.

The revision trigger prevents a normal native edit from preserving an old appointment version. Under PostgreSQL's default READ COMMITTED isolation, an update that waited for an earlier editor rechecks its condition against that editor's committed row. The fixture tests that actual wait, not a simulated pre-read. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED).

## 4. Failure and recovery

- A known constraint denial is a rejected attempt; a possibly sent transaction with no readable receipt is unknown. Deadlock, database loss, primary/failover uncertainty or process death must not produce an automatic second patient mutation.
- If the host proves rollback, its transaction contains neither appointment mutation nor receipt. That does not make an unproven external HTTP attempt safe to replay.
- An exact committed receipt describes this request's original result, even if another authorized actor subsequently changes the appointment. Current-state reporting is separate from attributing that later mutation to this request.
- A recovered process needs permitted host-owned action/attempt context. Passing an identity through a fixture is not proof of restart discovery, lost-context recovery or staff handling. Those remain explicit activation gates.
- No reservation exists while the caller considers an offer. An occupied destination at final commit fails without moving the original; offer new options and obtain fresh confirmation through the existing core.
- Policy/write-stop/notification ownership must be fenced and tested in the actual buyer adapter. This proof validates the diary transaction, not all A-01–A-08 requirements or the buyer's existing application.

## 5. Executable evidence

E2E-265 runs [the PostgreSQL contract test](../../test/storage/owning-host-write-contract.test.ts) through three distinct database backends. It holds the first transaction open, verifies the competing backend is blocked using `pg_blocking_pids`, then commits and inspects results independently. Cases cover partial overlap across businesses, adjacency, practitioner/tenant separation, equivalent UTC instants, invalid intervals, direct native insert refusal, identity removal/rename refusal, stale cancellation after a direct native edit, cancellation-versus-move, competing moves and booking-versus-move preserving the losing source, wrong target bindings, exact duplicate receipt binding, rollback, and observation-only receipt recovery.

The receipt recovery case intentionally discards the caller result. It does **not** claim a TCP reset during commit, actual process restart, whole-call adapter integration, buyer authorization, staff delivery or carrier proof. The host SQL fixture is not wired into a runnable patient-facing composition.

Final local validation on registered executable source `ae96e7d` passed:

- `npm run build:availability-console`, `npm run typecheck` and `git diff --check`.
- `node --test --test-concurrency=4 test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts test/cliniko/write-activation.test.ts`: eight passed, zero failures/skips.
- `bash scripts/with-postgres.sh node --test test/storage/owning-host-write-contract.test.ts`: 14 passed (13 scenarios and the parent), zero failures/skips.
- In each of two fresh disposable PostgreSQL instances, export `ABBY_LEDGER=postgres`, run `npm run db:migrate`, then `node scripts/ordered-node-e2e.mjs` with four-worker concurrency. The requested file order was `test/storage/owning-host-write-contract.test.ts`, `test/composition/cross-mode-agent-conformance.test.ts`, `test/composition/cross-mode-appointment-proposals.test.ts`, `test/storage/standalone-privacy-journey.test.ts`, and its reverse. The coordinator verified actual dispatch/completion, with 22 passed and zero failures/skips in each order. Existing strict-standalone database/backup privacy and disabled-write checks passed alongside the host proof.

Logs: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791019378313.log` (typecheck/registered/isolated), `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791019378569.log` (forward) and `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791019379074.log` (reverse). Subsequent edits document the result and provider questions only; executable source is unchanged.

## 6. Activation consequence

The appointment design is concrete enough for a buyer that can enforce the diary invariants to implement its host adapter. Before activation, integrate this mechanism into **every** native writer; protect related policy/terms; implement authorized action/receipt recovery and owned notifications/work; run whole-call and true processing-loss tests; and satisfy clinic/caller and transport approvals. A buyer without native diary ownership needs a provider-guaranteed alternative and cannot attest exclusivity merely because these local tests pass.

For standalone Cliniko, D-16 accepts best-effort ordinary writes; the actionable work is now actual caller/clinic authority, Cliniko-owned loss discovery and staff review, and operation-specific validation/inspection evidence. Stronger provider-supported conditional targets and atomic interval exclusion remain optional research, not prerequisites for that accepted contract. Pre-patient intake recovery and recall staff ownership remain separate from this native diary design.
