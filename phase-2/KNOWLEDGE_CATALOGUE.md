# Versioned clinic knowledge catalog

An explicitly configured embedded or reference owning host can use the PostgreSQL knowledge catalog. Standalone Cliniko hosts instead expose `NoStoredKnowledge` by default; an independently provisioned `OwnerFileClinicFAQs` source can supply already public clinic facts without enabling the database free-text editor. Its migration stores a per-location source head and immutable draft, approval, and revocation events. The head row is locked for each change, so two writers with the same expected version cannot both succeed. Scope includes tenant, clinic, and location. The in-memory catalog implements the same port for the local dashboard and browser journeys.

For the explicitly selected embedded catalog, clinic-admin agent commands can list the catalog, save a draft, approve its latest draft, and revoke its current approval. Each command has a versioned input/result schema. The direct lit-html dashboard uses those commands. Staff and caller agents cannot mutate or list the catalog. A draft never becomes answer evidence; a replacement draft keeps the preceding approval in force until approval. Revocation removes the effective approval immediately, including when a newer draft exists. The full event history retains actor and database timestamp in PostgreSQL.

Urgent request wording has its own location policy setting and audit. It is not a general answer source in this catalog or transient model context.

`TextReception` uses the injected catalog for direct answers and transient model context. Its model effect worker re-reads approved text before accepting a proposed answer. A recovering model worker must receive the same catalog through `EffectRecovery`'s knowledge lookup. The acceptor still checks scope, approval, effective dates, and exact answer text. PostgreSQL reads return a typed unavailable result on storage failure; no answer is produced from that failure.

The browser scenario covers draft, approval, reload, stale version, revocation, a later draft, unauthorized staff access, and the actual caller statement. The PostgreSQL case covers concurrent writers, restart, location isolation, caller answers, and revocation. `npm run probe:postgres` also migrates up, down, and up again with regenerated Kanel types.

The local dashboard is a reference server with an in-memory catalog and a fixed demo admin actor. An embedded deploying host must authenticate its actor and bind its explicitly selected catalog to the admin gateway, text reception, call admission service, and recovery workers. Omitting the catalog at admission leaves the legacy unpinned behavior.

New calls that receive an explicit catalog now capture its effective source refs and versions in the durable call policy at start or admission. They do not persist the answer text in that snapshot. Direct and model-assisted answers still re-read current approval, then the SAM acceptor checks both the current evidence and the captured version. A later approval edit cannot introduce a new fact into an active call; a changed or revoked source fails safely and requests staff follow-up. A later call captures the new version. Legacy calls without a snapshot continue their previous behavior until they end. Active-call knowledge overrides are not implemented.


## Owner-file process freshness candidate, 4 November 2026

The owner-provisioned public-file path has no process cache or database editor.
Each read captures the current file and approving membership, rereads policy and
content, and binds the complete decoded content. Changing text without changing
a revision label still invalidates the earlier call snapshot. A new call may
capture the newly approved facts; an existing call cannot adopt them.

A maintained [process control](../test/voice/clinic-faq-process-freshness.test.ts)
now keeps two independent OS workers alive against the same public FAQ and
administrator files. It exercises the actual `ClinikoCallFlow.publicFAQChoices`
selector and the agent `knowledge.answer.v2` route. Atomic bulk replacement,
reordering and removal retire old snapshots in both processes; fresh calls on
the same PIDs see exact current public contact and fee text. Revocation supplies
no facts. Malformed or unsafe files remain unavailable rather than a successful
empty read, and cannot revive a stale answer. Public price refusals keep their
separate owner wording and grant no visit-fee or waiver authority.

The new process case and one preserved agent case pass locally (2/2, zero skips).
The fixture forwards the existing call-admission policy hook so the call really
captures its FAQ snapshot; no production gate is bypassed. Earlier startup,
fixture-binding, type and refusal-wording failures remain private historical
results. This is source/process evidence, with no new runtime build or SQL,
provider, acoustic or clinic-acceptance claim. The affected graph passes the inherited project strict type checks. Whole-project
hosted checks, review, combined-parent qualification and normal delivery remain
separate gates.
