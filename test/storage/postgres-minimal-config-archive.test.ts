import assert from "node:assert/strict";
import test, { after } from "node:test";
import { ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceConfigArchiveImporter } from "../../src/reference/config-archive-import.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createStandaloneTextComposition } from "../../src/standalone/text-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresKnowledgeCatalogue } from "../../src/storage/postgres-knowledge-catalogue.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { decodeConfigArchive } from "../../src/portability/config-archive.ts";
import { verifyArchiveEnvelope } from "../../src/portability/archive-envelope.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

const authority = { authorizeAndRecord: async () => ok({ requestRef: "audited-minimal-export" }) };

test("standalone minimal settings export and stage without granting buyer capabilities", async () => {
  const scope = { tenantId: "minimal-export-source", clinicId: "clinic", locationId: "location" };
  const targetScope = { tenantId: "minimal-export-buyer", clinicId: "buyer", locationId: "location" };
  const app = createStandaloneTextComposition(db, new ReferenceClinicHost([], []));
  assert.equal((await app.policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok, true);
  const archive = await buildPostgresConfigArchive(db, { scope, targetScope, timeZone: "UTC",
    mappingProvenance: "reviewed-map", archiveId: "minimal-settings-archive", actorRef: "clinic-admin",
    createdAt: "2026-09-29T04:00:00Z" }, authority);
  assert.ok(archive.ok, archive.ok ? "" : archive.error.kind);
  assert.ok((await verifyArchiveEnvelope(archive.value)).ok);
  const chunks: Uint8Array[] = [];
  for await (const chunk of archive.value.sections.settings()) chunks.push(chunk);
  const settings = Buffer.concat(chunks).toString();
  assert.equal(settings.includes('"shape":"standaloneMinimal"'), true);
  assert.equal(settings.includes("approvedText"), false);
  assert.equal(settings.includes("capabilities"), false);
  const decoded = await decodeConfigArchive(archive.value, targetScope);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.value.policies.map(row => row.policy.bookingEnabled), [false, true]);
  assert.deepEqual(decoded.value.policies[1]?.policy.capabilities,
    { book: "unavailable", cancel: "unavailable", reschedule: "unavailable", intake: "unavailable", transfer: "unavailable" });
  assert.deepEqual(decoded.value.knowledge, []);

  const importer = new ReferenceConfigArchiveImporter(() => "2026-09-29T04:05:00Z");
  const importAuthority = { authorizeAndRecord: async () => ok({ auditRef: "audited-minimal-import" }) };
  const mapper = { mapRef: (kind: string, ref: string) => `buyer:${kind}:${ref}` };
  const staged = await importer.stage(archive.value, targetScope, "buyer-admin", importAuthority, mapper);
  assert.ok(staged.ok, staged.ok ? "" : staged.error.kind);
  const policy = await staged.value.policy.read(targetScope);
  assert.ok(policy.ok);
  assert.equal(policy.value.bookingEnabled, false);
  assert.deepEqual(Object.values(policy.value.capabilities), Array(5).fill("unavailable"));
  assert.equal(policy.value.greeting, undefined);
});

test("default archive rejects rich policy and any standalone knowledge draft", async () => {
  const richScope = { tenantId: "minimal-export-rich", clinicId: "clinic", locationId: "location" };
  const targetScope = { ...richScope, tenantId: "buyer-rich" };
  const rich = new PostgresPolicyStore(db, referenceDefaultPolicy);
  assert.equal((await rich.changeBookingEnabled(richScope, "0", true, "clinic-admin")).ok, true);
  const request = { scope: richScope, targetScope, timeZone: "UTC", mappingProvenance: "reviewed-map",
    archiveId: "rich-rejected", actorRef: "clinic-admin", createdAt: "2026-09-29T04:00:00Z" };
  assert.deepEqual(await buildPostgresConfigArchive(db, request, authority),
    { ok: false, error: { kind: "storageCorrupt" } });
  assert.ok((await buildPostgresConfigArchive(db, { ...request, archiveMode: "unsafeReference" }, authority)).ok);

  const scope = { tenantId: "minimal-export-knowledge", clinicId: "clinic", locationId: "location" };
  const app = createStandaloneTextComposition(db, new ReferenceClinicHost([], []));
  assert.equal((await app.policy.changeBookingEnabled(scope, "0", false, "clinic-admin")).ok, true);
  const catalogue = new PostgresKnowledgeCatalogue(db);
  assert.equal((await catalogue.saveDraft(scope, "parking", "0", "clinic-owner", "Patient name in draft",
    "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "clinic-admin")).ok, true);
  assert.deepEqual(await buildPostgresConfigArchive(db, { ...request, scope, targetScope: { ...scope, tenantId: "buyer-knowledge" },
    archiveId: "knowledge-rejected" }, authority), { ok: false, error: { kind: "storageCorrupt" } });
});

test("pristine standalone archive carries an explicit disabled default policy", async () => {
  const scope = { tenantId: "minimal-export-pristine", clinicId: "clinic", locationId: "location" };
  const targetScope = { tenantId: "minimal-export-pristine-buyer", clinicId: "buyer", locationId: "location" };
  const archive = await buildPostgresConfigArchive(db, { scope, targetScope, timeZone: "UTC",
    mappingProvenance: "reviewed-map", archiveId: "minimal-pristine-archive", actorRef: "clinic-admin",
    createdAt: "2026-09-29T04:00:00Z" }, authority);
  assert.ok(archive.ok);
  const decoded = await decodeConfigArchive(archive.value, targetScope);
  assert.ok(decoded.ok);
  assert.equal(decoded.value.policies.length, 1);
  assert.equal(decoded.value.policies[0]?.version, 0);
  assert.deepEqual(Object.values(decoded.value.policies[0]!.policy.capabilities), Array(5).fill("unavailable"));
  assert.equal(decoded.value.policies[0]?.policy.greeting, undefined);
});
