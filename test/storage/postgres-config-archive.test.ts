import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { verifyArchiveEnvelope } from "../../src/portability/archive-envelope.ts";
import type { ArchiveEnvelope, ArchiveSection } from "../../src/portability/archive-envelope.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresKnowledgeCatalogue } from "../../src/storage/postgres-knowledge-catalogue.ts";
import { buildPostgresConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import type { ConfigArchiveAuthority, ConfigArchiveRequest } from "../../src/storage/postgres-config-archive.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

async function records(archive: ArchiveEnvelope, section: ArchiveSection): Promise<Record<string, unknown>[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of archive.sections[section]()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("PostgreSQL config archive takes a consistent scoped snapshot with an allowlisted policy", async () => {
  const scope = { tenantId: "archive-config-tenant", clinicId: "archive-clinic", locationId: "archive-location" };
  const request: ConfigArchiveRequest = { scope, targetScope: { tenantId: "buyer", clinicId: "target-clinic", locationId: "target-location" },
    timeZone: "Australia/Sydney", mappingProvenance: "buyer-reviewed-map-1", archiveId: "config-archive-1",
    actorRef: "archive-admin", createdAt: "2026-09-28T22:00:00Z" };
  const authority: ConfigArchiveAuthority = { authorizeAndRecord: async () => ok({ requestRef: "audited-request-1" }) };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly");
  assert.equal((await policy.changeBookingEnabled(scope, "0", true, "archive-admin")).ok, true);
  const catalogue = new PostgresKnowledgeCatalogue(db);
  const draft = await catalogue.saveDraft(scope, "parking", "0", "clinic-owner", "Parking is behind the clinic.",
    "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "archive-admin");
  assert.equal(draft.ok, true);
  assert.equal((await catalogue.approve(scope, "parking", "1", "archive-admin")).ok, true);
  await sql`update clinic_settings set policy = policy || jsonb_build_object('apiKey', ${"secret-canary-never-export"}::text)
    where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} and location_id = ${scope.locationId}`.execute(db);

  const result = await buildPostgresConfigArchive(db, request, authority);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const verified = await verifyArchiveEnvelope(result.value);
  assert.equal(verified.ok, true);
  const locations = await records(result.value, "locations");
  const settings = await records(result.value, "settings");
  const knowledge = await records(result.value, "knowledge");
  assert.equal(locations.length, 1);
  assert.equal((locations[0]?.targetScope as { locationId: string }).locationId, "target-location");
  assert.equal(settings.some(row => row.kind === "locationPolicy" && (row.policy as { bookingEnabled: boolean }).bookingEnabled), true);
  assert.equal(settings.filter(row => row.kind === "locationPolicy" && row.isHead).length, 1);
  assert.deepEqual(knowledge.map(row => row.status), ["approved"]);
  assert.equal(knowledge[0]?.approvedText, "Parking is behind the clinic.");
  assert.equal(knowledge[0]?.isPublishedHead, true);
  assert.deepEqual(await records(result.value, "calls"), []);
  assert.deepEqual(await records(result.value, "staffWork"), []);
  const sectionText = (await Promise.all(["locations", "settings", "knowledge", "calls", "staffWork"].map(async name =>
    JSON.stringify(await records(result.value, name as ArchiveSection))))).join(" ");
  assert.equal(Buffer.from(result.value.manifestBytes).toString().includes("secret-canary-never-export"), false);
  assert.equal(sectionText.includes("secret-canary-never-export"), false);

  const call = await new PostgresLedger(db).start("archive-existing-call", referenceDefaultPolicy(scope));
  assert.equal(call.ok, true);
  const rejected = await buildPostgresConfigArchive(db, { ...request, archiveId: "config-archive-2" }, authority);
  assert.deepEqual(rejected, { ok: false, error: { kind: "callsRequireRetention" } });
});

test("config archive denies a request before reading settings", async () => {
  const scope = { tenantId: "archive-denied-tenant", clinicId: "clinic", locationId: "location" };
  const request: ConfigArchiveRequest = { scope, targetScope: scope, timeZone: "UTC", mappingProvenance: "map",
    archiveId: "denied-archive", actorRef: "unauthorized", createdAt: "2026-09-28T22:00:00Z" };
  const result = await buildPostgresConfigArchive(db, request, { authorizeAndRecord: async () => ({ ok: false, error: { kind: "denied" } }) });
  assert.deepEqual(result, { ok: false, error: { kind: "denied" } });
});

test("config archive refuses to omit another location in the source tenant", async () => {
  const scope = { tenantId: "archive-multilocation-tenant", clinicId: "clinic", locationId: "location-a" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly");
  assert.equal((await policy.changeBookingEnabled(scope, "0", true, "archive-admin")).ok, true);
  assert.equal((await policy.changeBookingEnabled({ ...scope, locationId: "location-b" }, "0", true, "archive-admin")).ok, true);
  const request: ConfigArchiveRequest = { scope, targetScope: scope, timeZone: "UTC", mappingProvenance: "map",
    archiveId: "partial-archive", actorRef: "archive-admin", createdAt: "2026-09-28T22:00:00Z" };
  const result = await buildPostgresConfigArchive(db, request, { authorizeAndRecord: async () => ok({ requestRef: "audited-partial" }) });
  assert.deepEqual(result, { ok: false, error: { kind: "scopeIncomplete" } });
});
