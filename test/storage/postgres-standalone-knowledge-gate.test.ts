import assert from "node:assert/strict";
import test, { after } from "node:test";
import { ok } from "../../src/core/model.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresKnowledgeCatalogue } from "../../src/storage/postgres-knowledge-catalogue.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("default knowledge catalogue cannot retain or reveal patient-bearing free text", async () => {
  const scope = { tenantId: "knowledge-gate-tenant", clinicId: "clinic", locationId: "location" };
  const canary = "PATIENT_SECRET_KNOWLEDGE_GATE_0930";
  const defaultCatalogue = new PostgresKnowledgeCatalogue(db);
  const unsafeFixture = new PostgresKnowledgeCatalogue(db, "unsafeReference");
  const draftArgs = [scope, "parking", "0", "owner", canary,
    "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "admin"] as const;
  assert.deepEqual(await defaultCatalogue.saveDraft(...draftArgs),
    { ok: false, error: { kind: "invalidValue" } });
  assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "rejected_draft", value: canary }]), ok([]));

  const fixture = await unsafeFixture.saveDraft(scope, "parking", "0", "owner", "Generic parking advice",
    "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "admin");
  assert.ok(fixture.ok);
  assert.ok((await unsafeFixture.approve(scope, "parking", "1", "admin")).ok);
  assert.deepEqual(await defaultCatalogue.list(scope), { ok: false, error: { kind: "storageFailure" } });
  assert.deepEqual(await defaultCatalogue.readKnowledge(scope, ["parking"]),
    { ok: false, error: { kind: "unavailable" } });
  assert.deepEqual(await defaultCatalogue.listModelKnowledge(scope, "2026-09-15T00:00:00Z"),
    { ok: false, error: { kind: "unavailable" } });
  assert.deepEqual(await defaultCatalogue.approve(scope, "parking", "2", "admin"),
    { ok: false, error: { kind: "invalidValue" } });
  assert.deepEqual(await defaultCatalogue.revoke(scope, "parking", "2", "admin"),
    { ok: false, error: { kind: "invalidValue" } });
});
