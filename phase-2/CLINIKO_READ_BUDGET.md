# Cliniko read budget

Cliniko [limits API requests to 200 per minute per user](https://docs.api.cliniko.com/#rate-limits) and returns HTTP 429 with a UNIX-seconds `X-RateLimit-Reset`. Every patient, availability, appointment, and recall adapter reserves through the `ClinikoRequestBudget` interface before HTTP. A quota denial returns typed `rateLimited`; a failed or malformed budget returns typed `unavailable`. Neither sends HTTP. A 429 is reported through the same interface; an absent or invalid reset header gives a one-minute cooldown. Requests are not automatically retried because the caller's turn or proof may be stale.

`ClinikoReadBudget` is the in-process adapter for synthetic and embedded tests. Pass one instance for the same Cliniko user. `PostgresClinikoRequestBudget` is the standalone adapter: each claim locks one PostgreSQL row and uses the database clock to enforce a rolling minute across processes. It defaults to 180 requests per minute, leaving headroom below Cliniko's published limit. The row holds only a SHA-256 digest of the configured key or user reference, bounded request times, the configured limit, and a cooldown. A database failure or conflicting limit for the same user fails closed. The standalone text command, availability console, and phone-index refresh worker use this adapter. The standalone voice server now requires a `PostgresClinikoRequestBudget` for every route, checks that the reader uses that exact instance, the budget belongs to the server's database, and both were configured from the same API key, and refuses startup otherwise. `E2E-163` exercises those refusals and verifies that six synthetic signed-call keypad reads appear in the durable budget row. These compositions derive the same budget from the same API key; set `ABBY_CLINIKO_BUDGET_USER_REF` to one stable, non-patient identifier when multiple keys belong to the same Cliniko user. All Abby processes for that user must use the same limit and user reference.

An acquiring host can supply its own adapter at this interface. Other applications using the same Cliniko user still consume the provider's account-wide quota; Abby cannot reserve their requests unless they share the host budget. The local tests cover 429 propagation and faulty host adapters. `E2E-156` through `E2E-160` use two PostgreSQL connections and real reader entry points where relevant to prove atomic claims, cross-process cooldown, fail-closed storage failure, shared user configuration, and absence of raw credentials or patient data in the budget row. They use fake provider responses and no live caller or demo-account write.

The standalone voice runner attaches a fixed-code diagnostics callback to this budget. A denied claim, failed budget claim, and upstream 429 each increment a separate clinic-scoped operational count. The callback receives only the code; it receives no key, patient, request URL, reset time or caller reference, and its failure cannot change the budget outcome. These are request-level counts rather than distinct callers. A signed synthetic 429 call and the two-connection budget tests verify the distinction; aggregate persistence and access controls are documented in the [outcome report](CALL_OUTCOME_REPORT.md).

The availability reader separately reports a fixed-code provider-unavailable event for an HTTP 5xx or failed fetch. It does not place the request URL, caller, patient or provider payload into the aggregate counter. A failed diagnostic callback cannot change the typed unavailable result. This count is distinct from provider 429 and from local budget failure; it is an operator signal, not an alert delivery or patient outcome.


## Shared operation allocations (E2E-416)

`withReservation` allocates a bounded number of requests for one operation for
at most30 seconds. Ordinary `claim` and `checkHeadroom` account for all live
allocations. An owner's native adapters consume its held balance; they cannot
fall back to ordinary capacity after exhaustion, expiry, abort or release.
Claims still count as sent for the rolling minute even when provider dispatch
is subsequently denied. Unused allocation is released when the callback ends;
process death leaves it unavailable only until database expiry.

The callback context carries no permission, patient proof or consent. Separate
adapters/connections using the same approved account reference share its context;
unrelated accounts remain independent. Same-account nesting is denied. Async
descendants retain a closed context after callback completion and cannot spend
released capacity. Provider429 cooldown, conflicting limits, malformed state or
storage failure still close the request path.

Migration048 adds only a UUID allocation reference, hashed budget reference,
remaining count and database expiry. The existing budget row lock serializes
allocation and claims. A database trigger also rejects older Abby workers'
sent-timestamp updates when those would consume held capacity on the same row.
Owners decrement their allocation before appending the timestamp in the same
transaction. The guard counts live timestamps, so expired entries do not prevent
legitimate work. This does not coordinate external applications that ignore the
shared database. Rollback requires a migration transaction and refuses to discard
any unexpired owner, including an allocation whose balance is zero.

The composed class movement host requires allocation support. It allocates the
same120/180-request amount checked by its existing confirmation admission and
retains the current30-second mutation deadline. A denial cannot invoke the task;
a callback interrupted after starting is potentially sent and maps to an
uncertain outcome. A budget port cannot fabricate the callback result or replay
it. All independent proof, current policy, played confirmation, native inspection
and financial checks remain. No schema contains patient/call/action IDs or raw
credentials, and no allocation appears in ordinary caller/model projections.

This protects admitted work against competing consumers of the shared budget.
It does not bound arbitrary callback I/O, guarantee recovery after every provider
fault, or stage larger movements across quota windows. Those operations still
need separate durable phase ownership, fresh authority and exact no-replay
reconciliation. Local and actual compiled qualification passes in the evidence below; full-call
and real clinic/cloud/voice acceptance remain open.

Qualification: final current-source type/build,74 native,18 PostgreSQL and4 rebuilt compiled checks pass in `4590eee3-1792030818771.log`; broader37 compiled checks pass before the final callback-lifetime fix in `4590eee3-1792030267657.log`. These counts overlap. See [the implementation evidence](THIRTEEN_GAP_IMPLEMENTATION.md#gap10-shared-account-allocation-e2e-416) for failed witnesses and limits.


### Native staged consumers

E2E-417 adds a separately approved native class-move consumer. It allocates one
bounded phase at a time, releases before quota waits, requires fresh phase
consent/current private proof and preserves the first offer expiry. Its Cliniko
review remains the patient-specific recovery record. This does not enable the
staged caller route or automatically resume an interrupted executor. See
[the staged native contract](CLINIKO_CLASS_PASSES.md#native-staged-class-movement-e2e-417).
