import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql } from "kysely";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoContactRevision } from "../../src/storage/postgres-cliniko-contact-revision.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { PostgresPatientPhoneScan } from "../../src/storage/postgres-patient-phone-scan.ts";
import { ClinikoPhoneLookup } from "../../src/standalone/cliniko-phone-lookup.ts";
import { emailFixture, apiKey as emailKey, initial } from "../support/email-patient-fixture.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });
const fp = clinikoCredentialFingerprint("synthetic-au5"), alias = clinikoCredentialFingerprint("synthetic-alias-au5");
const links = [{ normalizedPhone: "+61400111222", patientId: "101" }];
const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => { assert.ok(result.ok, JSON.stringify(result)); return result.value; };

test("E2E-364 account corrections fence every configured alias and clinic while preserving other tenants/accounts", async () => {
  const tenantId = `revision-${crypto.randomUUID()}`, index = new PostgresPatientPhoneIndex(db);
  const owner = new PostgresClinikoContactRevision(db, tenantId, [alias, fp]);
  const scopes = ["one", "two"].map(clinicId => ({ tenantId, clinicId }));
  const outsider = { tenantId: `${tenantId}-other`, clinicId: "one" };
  value(await index.publish(scopes[0]!, links, "61", fp));
  value(await index.publish(scopes[1]!, links, "61", alias));
  value(await index.publish(outsider, links, "61", fp));
  const ref = value(await owner.begin());
  for (const [i, fingerprint] of [fp, alias].entries()) {
    assert.deepEqual(value(await index.find(scopes[i]!, links[0]!.normalizedPhone, 60_000, "61", fingerprint)), { kind: "stale", patientIds: [] });
    assert.equal(value(await index.completedAt(scopes[i]!, "61", fingerprint)), null);
    assert.deepEqual(await index.publish(scopes[i]!, links, "61", fingerprint, 1, 1), { ok: false, error: { kind: "contactChanged" } });
  }
  assert.equal(value(await index.find(outsider, links[0]!.normalizedPhone, 60_000, "61", fp)).kind, "one");
  // A fresh process/store sees the durable pending fence. A subset cannot consume it.
  const restarted = new PostgresClinikoContactRevision(db, tenantId, [fp, alias]);
  assert.deepEqual(value(await restarted.read(fp)), { version: 1, blocked: true });
  assert.deepEqual(await new PostgresClinikoContactRevision(db, tenantId, [fp]).complete(ref), { ok: false, error: { kind: "contactChanged" } });
  value(await restarted.complete(ref));
  assert.deepEqual(value(await owner.read(alias)), { version: 2, blocked: false });
  assert.deepEqual(await owner.complete(ref), { ok: false, error: { kind: "contactChanged" } });
  // Old generations stay unusable after unblock; only a newly captured revision can publish.
  assert.equal(value(await index.find(scopes[0]!, links[0]!.normalizedPhone, 60_000, "61", fp)).kind, "stale");
  assert.deepEqual(await index.publish(scopes[0]!, links, "61", fp), { ok: false, error: { kind: "contactChanged" } });
  value(await index.publish(scopes[0]!, links, "61", fp, 1, 2));
  assert.equal(value(await index.find(scopes[0]!, links[0]!.normalizedPhone, 60_000, "61", fp)).kind, "one");
  const metadata = await sql<Record<string, unknown>>`select * from cliniko_contact_revisions where tenant_id = ${tenantId}`.execute(db);
  assert.deepEqual(Object.keys(metadata.rows[0]!).sort(), ["credential_fingerprint", "tenant_id", "version"]);
  const pending = value(await owner.begin());
  const changes = await sql<Record<string, unknown>>`select * from cliniko_contact_changes where tenant_id = ${tenantId}`.execute(db);
  assert.deepEqual(Object.keys(changes.rows[0]!).sort(), ["change_ref", "created_at", "credential_fingerprint", "tenant_id"]);
  assert.equal(JSON.stringify([...metadata.rows, ...changes.rows]).includes(links[0]!.normalizedPhone), false);
  value(await owner.complete(pending));
});

test("E2E-364 simultaneous corrections retain each other's durable fences without serializing patients", async () => {
  const tenantId = `revision-concurrent-${crypto.randomUUID()}`;
  const left = new PostgresClinikoContactRevision(db, tenantId, [fp, alias]);
  const right = new PostgresClinikoContactRevision(db, tenantId, [alias, fp]);
  const [first, second] = await Promise.all([left.begin(), right.begin()]);
  const firstRef = value(first), secondRef = value(second);
  assert.notEqual(firstRef, secondRef);
  assert.deepEqual(value(await left.read(fp)), { version: 2, blocked: true });
  value(await right.complete(secondRef));
  assert.deepEqual(value(await left.read(fp)), { version: 3, blocked: true });
  value(await left.complete(firstRef));
  assert.deepEqual(value(await right.read(alias)), { version: 4, blocked: false });
});

for (const staged of [false, true]) {
  test(`E2E-364 ${staged ? "staged" : "complete"} scan captured before correction cannot republish stale phones`, async () => {
    const scope = { tenantId: `revision-scan-${crypto.randomUUID()}`, clinicId: "one" };
    const owner = new PostgresClinikoContactRevision(db, scope.tenantId, [fp]);
    const index = new PostgresPatientPhoneIndex(db);
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
    let hold = true;
    const reader = value(ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5", contactEmail: "test@example.test" }, async () => {
      if (hold) { entered(); await held; }
      return Response.json({ total_entries: 1, patients: [{ id: "101", archived_at: null,
        patient_phone_numbers: [{ number: links[0]!.normalizedPhone, phone_type: "Mobile" }] }] });
    }));
    const lookup = new ClinikoPhoneLookup(reader, index, "61", 60_000, undefined, staged ? new PostgresPatientPhoneScan(db) : undefined);
    const refresh = lookup.refresh(scope);
    await reading;
    const ref = value(await owner.begin()); value(await owner.complete(ref)); release();
    assert.deepEqual(await refresh, { ok: false, error: { kind: "contactChanged" } });
    assert.equal(value(await index.find(scope, links[0]!.normalizedPhone, 60_000, "61", fp)).kind, "stale");
    hold = false; value(await lookup.refresh(scope));
    assert.equal(value(await index.find(scope, links[0]!.normalizedPhone, 60_000, "61", fp)).kind, "one");
  });
}

test("E2E-364 pending correction prevents new scans and restart cannot finish an older staged scan", async () => {
  const scope = { tenantId: `revision-restart-${crypto.randomUUID()}`, clinicId: "one" };
  const scan = new PostgresPatientPhoneScan(db), owner = new PostgresClinikoContactRevision(db, scope.tenantId, [fp]);
  const started = value(await scan.begin(scope, "61", fp));
  value(await scan.append(scope, started.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links }));
  value(await owner.begin()); // Deliberately unknown write: there is no automatic expiry.
  assert.deepEqual(await new PostgresPatientPhoneScan(db).finish(scope, started.scanRef), { ok: false, error: { kind: "contactChanged" } });
  assert.deepEqual(await new PostgresPatientPhoneScan(db).begin(scope, "61", fp), { ok: false, error: { kind: "contactChanged" } });
  assert.deepEqual(value(await new PostgresClinikoContactRevision(db, scope.tenantId, [fp]).read(fp)), { version: 1, blocked: true });
});

test("E2E-364 old unused codes, unconsumed grants and issued proofs never revive after an account correction", async () => {
  for (const stage of ["code", "grant", "proof"] as const) {
    const scope = { tenantId: `revision-proof-${crypto.randomUUID()}`, clinicId: "two", locationId: "main" };
    const fingerprint = clinikoCredentialFingerprint(emailKey), owner = new PostgresClinikoContactRevision(db, scope.tenantId, [fingerprint]);
    const f = emailFixture({ scope, contactRevision: owner });
    try {
      await f.authority.start("appointments.read"); assert.equal(f.mail.length, 1);
      const grant = stage === "code" ? undefined : value(await f.authority.answer(f.mail[0]!.code));
      const proof = stage === "proof" ? value(await f.proof.issue(grant!, "appointments.read")) : undefined;
      const ref = value(await owner.begin()); value(await owner.complete(ref));
      if (stage === "code") assert.equal((await f.authority.answer(f.mail[0]!.code)).ok, false);
      if (stage === "grant") assert.equal((await f.proof.issue(grant!, "appointments.read")).ok, false);
      if (stage === "proof") assert.equal((await f.proof.verifyOperation(scope, proof!.verificationRef, "appointments.read", new Date(initial).toISOString())).ok, false);
      // Email, phone, patient and candidates did not change. A new call can verify at the new revision.
      const next = emailFixture({ scope, contactRevision: new PostgresClinikoContactRevision(db, scope.tenantId, [fingerprint]) });
      await next.authority.start("appointments.read");
      assert.equal((await next.authority.answer(next.mail[0]!.code)).ok, true); next.authority.close(); next.proof.dispose();
    } finally { f.authority.close(); f.proof.dispose(); }
  }
});

test("E2E-364 revision exhaustion rolls back all aliases and pending tokens atomically", async () => {
  const tenantId = `revision-overflow-${crypto.randomUUID()}`, sorted = [alias, fp].sort();
  await sql`insert into cliniko_contact_revisions (tenant_id, credential_fingerprint, version)
    values (${tenantId}, ${sorted[0]}, 7), (${tenantId}, ${sorted[1]}, 2147483647)`.execute(db);
  const owner = new PostgresClinikoContactRevision(db, tenantId, [fp, alias]);
  assert.deepEqual(await owner.begin(), { ok: false, error: { kind: "storageFailure" } });
  assert.deepEqual(value(await owner.read(sorted[0]!)), { version: 7, blocked: false });
  assert.deepEqual(value(await owner.read(sorted[1]!)), { version: 2147483647, blocked: false });
});
