import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { ok } from "../../src/core/model.ts";
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
  const app = createStandaloneTextComposition(db);
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

test("E2E-229 minimal archive carries approved after-hours text and its separate audit into an embedded host", async () => {
  const scope = { tenantId: "after-hours-export-source", clinicId: "clinic", locationId: "location" };
  const targetScope = { tenantId: "after-hours-export-buyer", clinicId: "buyer", locationId: "location" };
  const app = createStandaloneTextComposition(db);
  const info = { scope, version: "holiday-v1", ownerRef: "clinic-admin",
    approvedText: "The clinic reopens Tuesday at 9 am.", approved: true as const };
  assert.equal((await app.policy.changeAfterHours(scope, "0", "approvedInfoAndRequest", info, "clinic-admin")).ok, true);
  assert.equal((await app.policy.changeBookingEnabled(scope, "1", true, "clinic-admin")).ok, true);
  const archive = await buildPostgresConfigArchive(db, { scope, targetScope, timeZone: "UTC",
    mappingProvenance: "reviewed-map", archiveId: "after-hours-settings-archive", actorRef: "clinic-admin",
    createdAt: "2026-09-29T04:00:00Z" }, authority);
  assert.ok(archive.ok, archive.ok ? "" : archive.error.kind);
  const decoded = await decodeConfigArchive(archive.value, targetScope);
  assert.ok(decoded.ok, decoded.ok ? "" : decoded.error.kind);
  assert.deepEqual(decoded.value.policies.map(row => [row.version, row.settingKind]),
    [[0, "booking"], [1, "afterHours"], [2, "booking"]]);
  assert.equal(decoded.value.policies[2]?.policy.afterHoursInfo?.approvedText, info.approvedText);
  const importer = new ReferenceConfigArchiveImporter(() => "2026-09-29T04:05:00Z");
  const staged = await importer.stage(archive.value, targetScope, "buyer-admin",
    { authorizeAndRecord: async () => ok({ auditRef: "audited-after-hours-import" }) },
    { mapRef: (kind: string, ref: string) => `buyer:${kind}:${ref}` });
  assert.ok(staged.ok, staged.ok ? "" : staged.error.kind);
  const imported = await staged.value.policy.read(targetScope);
  assert.ok(imported.ok);
  assert.equal(imported.value.bookingEnabled, false);
  assert.equal(imported.value.afterHoursMode, "approvedInfoAndRequest");
  assert.equal(imported.value.afterHoursInfo?.ownerRef, "buyer:afterHoursOwner:clinic-admin");
  assert.equal(imported.value.afterHoursInfo?.approvedText, info.approvedText);
  const history = await staged.value.policy.listAfterHoursChanges(targetScope);
  assert.ok(history.ok);
  assert.deepEqual(history.value.entries.map(row => row.version), ["1"]);
  const bookingHistory = await staged.value.policy.listBookingChanges(targetScope);
  assert.ok(bookingHistory.ok);
  assert.deepEqual(bookingHistory.value.entries.map(row => row.version), ["2", "3"]);
});

test("E2E-232 minimal archive maps the scoped urgent script and distinct audit into an embedded host", async () => {
  const suffix = randomUUID();
  const scope = { tenantId: `urgent-export-source-${suffix}`, clinicId: "clinic", locationId: "location" };
  const targetScope = { tenantId: `urgent-export-buyer-${suffix}`, clinicId: "buyer", locationId: "location" };
  const app = createStandaloneTextComposition(db);
  const script = { scope, version: "urgent-v1", ownerRef: "clinic-admin",
    approvedText: "If you need immediate help, contact your local emergency service now.", approved: true as const,
    effectiveFrom: "2026-09-28T00:00:00.000Z", effectiveUntil: "2027-09-28T00:00:00.000Z" };
  assert.equal((await app.policy.changeUrgentResponse(scope, "0", script, "clinic-admin")).ok, true);
  assert.equal((await app.policy.changeBookingEnabled(scope, "1", false, "clinic-admin")).ok, true);
  const archive = await buildPostgresConfigArchive(db, { scope, targetScope, timeZone: "UTC",
    mappingProvenance: "reviewed-map", archiveId: `urgent-settings-archive-${suffix}`, actorRef: "clinic-admin",
    createdAt: "2026-09-29T04:00:00Z" }, authority);
  assert.ok(archive.ok, archive.ok ? "" : archive.error.kind);
  const decoded = await decodeConfigArchive(archive.value, targetScope);
  assert.ok(decoded.ok, decoded.ok ? "" : decoded.error.kind);
  assert.deepEqual(decoded.value.policies.map(row => [row.version, row.settingKind]),
    [[0, "booking"], [1, "urgent"], [2, "booking"]]);
  assert.equal(decoded.value.policies[2]?.policy.urgentResponse?.approvedText, script.approvedText);
  const staged = await new ReferenceConfigArchiveImporter(() => "2026-09-29T04:05:00Z").stage(
    archive.value, targetScope, "buyer-admin",
    { authorizeAndRecord: async () => ok({ auditRef: "audited-urgent-import" }) },
    { mapRef: (kind: string, ref: string) => `buyer:${kind}:${ref}` });
  assert.ok(staged.ok, staged.ok ? "" : staged.error.kind);
  const imported = await staged.value.policy.read(targetScope);
  assert.ok(imported.ok);
  assert.deepEqual(imported.value.urgentResponse?.scope, targetScope);
  assert.equal(imported.value.urgentResponse?.ownerRef, "buyer:urgentOwner:clinic-admin");
  assert.equal(imported.value.urgentResponse?.approvedText, script.approvedText);
  const history = await staged.value.policy.listUrgentResponseChanges(targetScope);
  assert.ok(history.ok);
  assert.deepEqual(history.value.entries.map(row => [row.version, row.enabled, row.previousEnabled]), [["1", true, false]]);
  const booking = await staged.value.policy.listBookingChanges(targetScope);
  assert.ok(booking.ok);
  assert.deepEqual(booking.value.entries.map(row => row.version), ["2"]);
});

test("default archive rejects rich policy and any standalone knowledge draft", async () => {
  const richScope = { tenantId: "minimal-export-rich", clinicId: "clinic", locationId: "location" };
  const targetScope = { ...richScope, tenantId: "buyer-rich" };
  const rich = new PostgresPolicyStore(db, referenceDefaultPolicy, undefined, undefined, true, "unsafeReference");
  assert.equal((await rich.changeBookingEnabled(richScope, "0", true, "clinic-admin")).ok, true);
  const request = { scope: richScope, targetScope, timeZone: "UTC", mappingProvenance: "reviewed-map",
    archiveId: "rich-rejected", actorRef: "clinic-admin", createdAt: "2026-09-29T04:00:00Z" };
  assert.deepEqual(await buildPostgresConfigArchive(db, request, authority),
    { ok: false, error: { kind: "storageCorrupt" } });
  assert.ok((await buildPostgresConfigArchive(db, { ...request, archiveMode: "unsafeReference" }, authority)).ok);

  const scope = { tenantId: "minimal-export-knowledge", clinicId: "clinic", locationId: "location" };
  const app = createStandaloneTextComposition(db);
  assert.equal((await app.policy.changeBookingEnabled(scope, "0", false, "clinic-admin")).ok, true);
  const catalogue = new PostgresKnowledgeCatalogue(db, "unsafeReference");
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
