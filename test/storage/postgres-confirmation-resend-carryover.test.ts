import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import type { ArchiveEnvelope, ArchiveSection } from "../../src/portability/archive-envelope.ts";
import { materializeVerifiedArchive } from "../../src/portability/archive-envelope.ts";
import { decodeConfigArchive, decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { ReferenceConfigArchiveImporter } from "../../src/reference/config-archive-import.ts";
import { ReferenceTenantConfigArchiveImporter } from "../../src/reference/tenant-config-archive-import.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { DurableConfirmationSubmission } from "../../src/standalone/durable-confirmation-submission.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresTenantConfigArchive, buildPostgresFencedTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresConfirmationResendJournal } from "../../src/storage/postgres-confirmation-resend-journal.ts";
import { readConfirmationResendCarryover, reconcileConfirmationResendCarryover } from "../../src/storage/postgres-confirmation-resend-carryover.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import { comparePostgresConfigArchiveSource } from "../../src/storage/postgres-config-archive-drift.ts";
import { comparePostgresFencedTenantArchiveSource } from "../../src/storage/postgres-fenced-archive-compare.ts";
import { targetReady } from "../../src/storage/postgres-cutover-target.ts";
import type { TargetImportRow } from "../../src/storage/postgres-cutover-target.ts";
import { value } from "../support/voice-settings-contract.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
const authority = { authorizeAndRecord: async () => ok({ auditRef: "synthetic-resend-import-audit" }) };
const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: "synthetic-resend-export-audit" }) };
const mapper = { mapRef: () => "disabled" };
const importedAt = "2026-10-14T04:00:00.000Z";
const binding = "b".repeat(64);

async function fixture(count = 2, archiveMode: "standaloneMinimal" | "unsafeReference" = "standaloneMinimal", populate = true) {
  const id = randomUUID(), source = { tenantId: `resend-export-${id}`, clinicId: "source", locationId: "first" };
  const target = { tenantId: `resend-import-${id}`, clinicId: "buyer", locationId: "mapped-first" };
  const locations = Array.from({ length: count }, (_, i) => ({ sourceScope: { ...source, locationId: i ? "second" : "first" },
    targetScope: { ...target, locationId: i ? "mapped-second" : "mapped-first" }, timeZone: "UTC", mappingProvenance: "reviewed" }));
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable", undefined, false, archiveMode);
  for (const location of locations) value(await policy.changeBookingEnabled(location.sourceScope, "0", false, "synthetic-owner"));
  if (populate) for (const [i, status] of ["possiblySent", "accepted", "unknown", "definitiveUnsent", "accepted"].entries()) {
    const journal = new PostgresConfirmationResendJournal(db, locations[i % count]!.sourceScope, binding), requestRef = randomUUID();
    value(await journal.claim(requestRef));
    if (status !== "possiblySent") value(await journal.finish(requestRef, status === "accepted"
      ? { kind: "accepted", messageRef: i === 4 ? randomUUID() : requestRef }
      : { kind: status as "unknown" | "definitiveUnsent" }));
  }
  const request = { sourceTenantId: source.tenantId, archiveId: `resend-archive-${id}`, actorRef: "synthetic-owner",
    createdAt: "2026-10-14T03:00:00.000Z", archiveMode, locations };
  const archive = value(await buildPostgresTenantConfigArchive(db, request, exportAuthority));
  const data = value(await decodeTenantConfigArchive(archive, target.tenantId));
  return { source, target, locations, request, archive, data };
}

async function editWork(input: ArchiveEnvelope, edit: (rows: Record<string, unknown>[]) => Record<string, unknown>[]): Promise<ArchiveEnvelope> {
  const archive = value(await materializeVerifiedArchive(input)), parts = { ...archive.sections };
  const rows = Buffer.from(parts.staffWork).toString().trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  const next = edit(rows).sort((a, b) => String(a.recordId).localeCompare(String(b.recordId)));
  parts.staffWork = Buffer.from(next.map(row => JSON.stringify(row) + "\n").join(""));
  const manifest = JSON.parse(Buffer.from(archive.manifestBytes).toString());
  manifest.sections.staffWork = { version: 1, recordCount: next.length, byteCount: parts.staffWork.byteLength,
    sha256: createHash("sha256").update(parts.staffWork).digest("hex") };
  const section = (name: ArchiveSection) => async function* () { yield parts[name]; };
  return { manifestBytes: Buffer.from(JSON.stringify(manifest)), sections: { locations: section("locations"), settings: section("settings"),
    knowledge: section("knowledge"), calls: section("calls"), staffWork: section("staffWork") } };
}

test("E2E-378 resend history survives mapped multi-location import and every imported UUID refuses SMTP replay", async () => {
  const f = await fixture(), importer = new PostgresTenantConfigArchiveImporter(db, () => importedAt);
  assert.equal(f.data.sectionManifests.staffWork.recordCount, 5);
  const reference = value(await new ReferenceTenantConfigArchiveImporter(() => importedAt).stage(f.archive, f.target.tenantId, "buyer", authority, mapper));
  assert.deepEqual(reference.sourceHistory, f.data);
  const staged = value(await importer.stage(f.archive, f.target.tenantId, "buyer", authority, mapper));
  assert.deepEqual(value(await importer.stage(f.archive, f.target.tenantId, "buyer", authority, mapper)), staged);
  assert.equal(value(await importer.preflight(f.archive, f.target.tenantId, "buyer", authority, mapper)).status, "alreadyStaged");
  assert.equal(await reconcileConfirmationResendCarryover(db, f.data), true);
  assert.deepEqual(value(await importer.read(f.target.tenantId, "buyer", authority))?.sourceHistory, f.data);
  let sends = 0;
  for (const location of f.data.locations) for (const row of location.confirmationResends ?? []) {
    const journal = new PostgresConfirmationResendJournal(db, location.targetScope, row.ownerBinding);
    assert.equal(value(await journal.claim(row.requestRef)).send, false);
    const submitter = new DurableConfirmationSubmission(journal, { send: async () => { sends++; throw new Error("must not send"); } });
    const outcome = await submitter.submit(row.requestRef, { email: "synthetic-patient@example.invalid", startsAt: "2026-10-15T01:00:00.000Z",
      endsAt: "2026-10-15T01:30:00.000Z", timeZone: "UTC", clinicName: "Synthetic clinic", locationName: "Synthetic location",
      locationAddress: "Synthetic address", practitionerName: "Synthetic practitioner", appointmentTypeName: "Synthetic assessment" }, new AbortController().signal);
    assert.deepEqual(outcome, row.status === "accepted" && row.messageRef === row.requestRef
      ? { kind: "accepted", messageRef: row.requestRef } : { kind: row.status === "possiblySent" || row.status === "accepted" ? "unknown" : row.status });
    assert.deepEqual(await new PostgresConfirmationResendJournal(db, location.targetScope, "c".repeat(64)).claim(row.requestRef),
      { ok: false, error: { kind: "bindingMismatch" } });
  }
  assert.equal(sends, 0);
  assert.equal(await reconcileConfirmationResendCarryover(db, f.data), true);
  const records = JSON.stringify(await readConfirmationResendCarryover(db, f.target.tenantId));
  for (const canary of ["synthetic-patient@example.invalid", "Synthetic address", "Synthetic practitioner", "patientId", "appointmentId", "proof", "email"]) assert.equal(records.includes(canary), false);
});

test("E2E-378 single-location and empty legacy views retain accurate submission counts", async () => {
  const f = await fixture(1), decoded = value(await decodeConfigArchive(f.archive, f.target));
  assert.equal(decoded.confirmationResends?.length, 5);
  const importer = new ReferenceConfigArchiveImporter(() => importedAt);
  const preflight = value(await importer.preflight(f.archive, f.target, "buyer", authority, mapper));
  assert.equal(preflight.recordCounts.staffWork, 5);
  assert.deepEqual(value(await importer.stage(f.archive, f.target, "buyer", authority, mapper)).sourceHistory.confirmationResends, decoded.confirmationResends);
  const empty = await fixture(1, "standaloneMinimal", false);
  assert.equal(empty.data.locations[0]!.confirmationResends, undefined);
  value(await new PostgresTenantConfigArchiveImporter(db, () => importedAt).stage(empty.archive, empty.target.tenantId, "buyer", authority, mapper));
  assert.equal(await reconcileConfirmationResendCarryover(db, empty.data), true);
});

test("E2E-378 resealed private, inconsistent, duplicate and foreign submission rows fail semantic decoding", async () => {
  const f = await fixture();
  const edits = [
    (rows: Record<string, unknown>[]) => rows.map(row => ({ ...row, email: "synthetic-patient@example.invalid" })),
    (rows: Record<string, unknown>[]) => rows.map(row => ({ ...row, ownerBinding: "wrong" })),
    (rows: Record<string, unknown>[]) => rows.map(row => ({ ...row, originScope: { tenantId: "origin", clinicId: "origin", locationId: "origin", email: "synthetic-patient@example.invalid" } })),
    (rows: Record<string, unknown>[]) => rows.map(row => ({ ...row, createdAt: "2026-02-31T01:00:00.000Z" })),
    (rows: Record<string, unknown>[]) => rows.map(row => ({ ...row, sourceLocationId: "unmapped" })),
    (rows: Record<string, unknown>[]) => rows.map(row => ({ ...row, sourceTenantId: "foreign" })),
    (rows: Record<string, unknown>[]) => rows.map(row => ({ ...row, status: "possiblySent", completedAt: importedAt })),
    (rows: Record<string, unknown>[]) => rows.map(row => ({ ...row, status: "accepted", messageRef: null })),
    (rows: Record<string, unknown>[]) => [...rows, { ...rows[0]!, sourceLocationId: rows[0]!.sourceLocationId === "first" ? "second" : "first" }],
  ];
  for (const edit of edits) assert.equal((await decodeTenantConfigArchive(await editWork(f.archive, edit), f.target.tenantId)).ok, false);
});

test("E2E-378 journal-only source locations and occupied targets cannot be silently omitted or overwritten", async () => {
  const f = await fixture();
  value(await new PostgresConfirmationResendJournal(db, { ...f.source, clinicId: "unlisted", locationId: "unlisted" }, binding).claim(randomUUID()));
  assert.deepEqual(await buildPostgresTenantConfigArchive(db, f.request, exportAuthority), { ok: false, error: { kind: "scopeIncomplete" } });
  value(await new PostgresConfirmationResendJournal(db, f.target, binding).claim(randomUUID()));
  const before = await readConfirmationResendCarryover(db, f.target.tenantId), importer = new PostgresTenantConfigArchiveImporter(db, () => importedAt);
  for (const result of [await importer.preflight(f.archive, f.target.tenantId, "buyer", authority, mapper),
    await importer.stage(f.archive, f.target.tenantId, "buyer", authority, mapper)]) assert.deepEqual(result, { ok: false, error: { kind: "targetOccupied" } });
  assert.deepEqual(await readConfirmationResendCarryover(db, f.target.tenantId), before);
});

test("E2E-378 altered, missing and unlisted target resend barriers block cutover and idempotent import", async () => {
  const f = await fixture(2, "unsafeReference"), importer = new PostgresTenantConfigArchiveImporter(db, () => importedAt, "unsafeReference");
  value(await importer.stage(f.archive, f.target.tenantId, "buyer", authority, mapper));
  const registry = (await sql<TargetImportRow>`select archive_id, manifest_digest, receipt, source_history from tenant_config_imports
    where target_tenant_id = ${f.target.tenantId}`.execute(db)).rows[0]!;
  const ready = () => db.transaction().execute(trx => targetReady(trx, f.data, registry));
  assert.equal(await ready(), true);
  const pending = f.data.locations.flatMap(location => location.confirmationResends ?? []).find(row => row.status === "possiblySent")!;
  await sql`update confirmation_resend_journal set owner_binding = ${"c".repeat(64)} where tenant_id = ${f.target.tenantId} and request_ref = ${pending.requestRef}::uuid`.execute(db);
  assert.equal(await ready(), false);
  assert.deepEqual(await importer.stage(f.archive, f.target.tenantId, "buyer", authority, mapper), { ok: false, error: { kind: "storageFailure" } });
  await sql`update confirmation_resend_journal set owner_binding = ${pending.ownerBinding} where tenant_id = ${f.target.tenantId} and request_ref = ${pending.requestRef}::uuid`.execute(db);
  assert.equal(await ready(), true);
  await sql`update confirmation_resend_journal set created_at = '2030-01-01T00:00:00Z'
    where tenant_id = ${f.target.tenantId} and request_ref = ${pending.requestRef}::uuid`.execute(db);
  assert.equal(await ready(), false, "timestamp edits cannot escape reconciliation");
  await sql`update confirmation_resend_journal set created_at = ${pending.createdAt}::timestamptz,
    status = 'unknown', completed_at = '2030-01-01T00:00:00Z'
    where tenant_id = ${f.target.tenantId} and request_ref = ${pending.requestRef}::uuid`.execute(db);
  assert.equal(await ready(), false, "a changed outcome cannot silently replace an imported barrier");
  await sql`update confirmation_resend_journal set status = 'possiblySent', completed_at = null
    where tenant_id = ${f.target.tenantId} and request_ref = ${pending.requestRef}::uuid`.execute(db);
  assert.equal(await ready(), true);
  const extra = randomUUID(); value(await new PostgresConfirmationResendJournal(db, { ...f.target, locationId: "unlisted" }, binding).claim(extra));
  assert.equal(await ready(), false);
  await sql`delete from confirmation_resend_journal where tenant_id = ${f.target.tenantId} and request_ref = ${extra}::uuid`.execute(db);
  assert.equal(await ready(), true);
  await sql`delete from confirmation_resend_journal where tenant_id = ${f.target.tenantId} and request_ref = ${pending.requestRef}::uuid`.execute(db);
  assert.equal(await ready(), false);
  assert.deepEqual(await importer.preflight(f.archive, f.target.tenantId, "buyer", authority, mapper), { ok: false, error: { kind: "storageFailure" } });
});

test("E2E-378 source drift and frozen final comparison detect omitted resend history", async () => {
  const f = await fixture(1), journal = new PostgresConfirmationResendJournal(db, f.source, binding);
  value(await journal.claim(randomUUID()));
  const drift = value(await comparePostgresConfigArchiveSource(db, f.archive, { scope: f.source, targetScope: f.target,
    archiveId: `compare-${randomUUID()}`, actorRef: "synthetic-owner", createdAt: f.request.createdAt, timeZone: "UTC", mappingProvenance: "reviewed" }, exportAuthority));
  assert.equal(drift.kind, "changed"); assert.deepEqual(drift.changed, ["staffWork"]);
  value(await new PostgresPortabilityFence(db).freeze({ tenantId: f.source.tenantId, actorRef: "synthetic-owner", reason: "cutoverFreeze" }, exportAuthority));
  const finalRequest = { ...f.request, archiveId: `final-${randomUUID()}`, expectedFenceVersion: 1 };
  const final = value(await buildPostgresFencedTenantConfigArchive(db, finalRequest, exportAuthority));
  assert.equal((await journal.claim(randomUUID())).ok, false, "a frozen source cannot create a new send barrier");
  const comparison = { ...finalRequest, archiveId: `final-compare-${randomUUID()}` };
  assert.equal(value(await comparePostgresFencedTenantArchiveSource(db, final, comparison, exportAuthority)).kind, "unchanged");
  const omitted = await editWork(final, () => []);
  const changed = value(await comparePostgresFencedTenantArchiveSource(db, omitted, comparison, exportAuthority));
  assert.equal(changed.kind, "changed"); assert.deepEqual(changed.changed, ["staffWork"]);
});


test("E2E-378 a failed journal insertion rolls back the entire configuration import", async () => {
  const f = await fixture(), importer = new PostgresTenantConfigArchiveImporter(db, () => importedAt);
  const name = `resend_test_${randomUUID().replaceAll("-", "")}`;
  // This trigger exists only in the disposable synthetic database and only rejects this target tenant.
  await sql`create function ${sql.id(name)}() returns trigger language plpgsql as
    'begin raise exception ''synthetic resend insertion failure''; end'`.execute(db);
  try {
    await sql`create trigger ${sql.id(name)} before insert on confirmation_resend_journal for each row
      when (new.tenant_id = ${sql.lit(f.target.tenantId)}) execute function ${sql.id(name)}()`.execute(db);
    assert.deepEqual(await importer.stage(f.archive, f.target.tenantId, "buyer", authority, mapper),
      { ok: false, error: { kind: "storageFailure" } });
    assert.deepEqual(await readConfirmationResendCarryover(db, f.target.tenantId), []);
    const count = (await sql<{ count: number }>`select (
      (select count(*) from clinic_settings where tenant_id = ${f.target.tenantId}) +
      (select count(*) from clinic_write_stop where tenant_id = ${f.target.tenantId}) +
      (select count(*) from tenant_config_imports where target_tenant_id = ${f.target.tenantId})
    )::int as count`.execute(db)).rows[0]!.count;
    assert.equal(count, 0);
  } finally {
    await sql`drop trigger if exists ${sql.id(name)} on confirmation_resend_journal`.execute(db);
    await sql`drop function ${sql.id(name)}()`.execute(db);
  }
  value(await importer.stage(f.archive, f.target.tenantId, "buyer", authority, mapper));
  assert.equal(await reconcileConfirmationResendCarryover(db, f.data), true);
});

test("E2E-378 corrupt source receipt timestamps cannot be exported as empty or repaired history", async () => {
  const f = await fixture(1), completed = f.data.locations[0]!.confirmationResends!.find(row => row.status === "accepted")!;
  await sql`update confirmation_resend_journal set created_at = '2030-01-01T00:00:00Z'
    where tenant_id = ${f.source.tenantId} and request_ref = ${completed.requestRef}::uuid`.execute(db);
  assert.deepEqual(await buildPostgresTenantConfigArchive(db, f.request, exportAuthority),
    { ok: false, error: { kind: "storageCorrupt" } });
});
