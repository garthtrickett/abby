import assert from "node:assert/strict";
import test, { after } from "node:test";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { normalizePatientPhone } from "../../src/cliniko/phone-number.ts";
import { ClinikoPhoneLookup } from "../../src/standalone/cliniko-phone-lookup.ts";
import { PhoneIndexRefreshWorker } from "../../src/standalone/phone-index-refresh-worker.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("Cliniko phone index stores only phone-to-ID links and rechecks shared candidates live", async () => {
  const scope = { tenantId: "phone-index-tenant", clinicId: "phone-index-clinic" };
  const phone = "+61400111222";
  let secondPhone = "0400 111 222";
  let failRefresh = false;
  const fetchPort: typeof fetch = async (input) => {
    const request = new URL(String(input));
    if (request.pathname === "/v1/patients") {
      if (failRefresh) return Response.json({ total_entries: 2, patients: [] });
      assert.equal(request.searchParams.get("per_page"), "100");
      return Response.json({ total_entries: 2, patients: [
        { id: "101", first_name: "canary-private-name", appointment_notes: "canary-private-note",
          archived_at: null, patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }] },
        { id: "102", first_name: "second-private-name", archived_at: null,
          patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Home" }] },
      ] });
    }
    if (request.pathname === "/v1/patients/101") return Response.json({ id: "101", archived_at: null,
      first_name: "canary-private-name", patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }] });
    if (request.pathname === "/v1/patients/102") return Response.json({ id: "102", archived_at: null,
      first_name: "second-private-name", patient_phone_numbers: [{ number: secondPhone, phone_type: "Home" }] });
    throw new Error("unexpected Cliniko request");
  };
  const created = ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5",
    contactEmail: "test@example.com" }, fetchPort);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const index = new PostgresPatientPhoneIndex(db);
  const lookup = new ClinikoPhoneLookup(created.value, index, "61", 60_000);
  const published = await lookup.refresh(scope);
  assert.equal(published.ok, true, JSON.stringify(published));
  const shared = await lookup.candidates(scope, "0400 111 222");
  assert.deepEqual(shared, { ok: true, value: { kind: "multiple", candidateIds: ["101", "102"] } });
  const rows = await db.selectFrom("patient_phone_index").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute();
  assert.equal(rows.length, 2);
  assert.deepEqual([...new Set(rows.map(row => String(row.normalized_phone)))], [phone]);
  assert.equal(JSON.stringify(rows).includes("private"), false);
  assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), ["clinic_id", "normalized_phone", "patient_id", "tenant_id"]);

  secondPhone = "0400 999 999";
  const changed = await lookup.candidates(scope, "+61 400 111 222");
  assert.deepEqual(changed, { ok: true, value: { kind: "one", candidateIds: ["101"] } });
  failRefresh = true;
  const failed = await lookup.refresh(scope);
  assert.equal(failed.ok, false);
  const preserved = await index.find(scope, phone, 60_000);
  assert.equal(preserved.ok && preserved.value.kind, "multiple");
  const stale = await index.find(scope, phone, 60_000, new Date(Date.now() + 120_000));
  assert.deepEqual(stale, { ok: true, value: { kind: "stale", patientIds: [] } });
  const otherClinic = await index.find({ ...scope, clinicId: "other-clinic" }, phone, 60_000);
  assert.deepEqual(otherClinic, { ok: true, value: { kind: "stale", patientIds: [] } });
  assert.deepEqual(await lookup.candidates(scope, "withheld"), { ok: true, value: { kind: "noNumber", candidateIds: [] } });
});

test("phone normalization accepts explicit international and configured national forms only", () => {
  assert.equal(normalizePatientPhone("0400 111 222", "61"), "+61400111222");
  assert.equal(normalizePatientPhone("+61 (400) 111-222", "61"), "+61400111222");
  assert.equal(normalizePatientPhone("400111222", "61"), undefined);
  assert.equal(normalizePatientPhone("0400 111 222 ext 4", "61"), undefined);
});

test("Cliniko full scan follows all pages before publishing a generation", async () => {
  const scope = { tenantId: "phone-pages-tenant", clinicId: "phone-pages-clinic" };
  const pages: number[] = [];
  const fetchPort: typeof fetch = async input => {
    const request = new URL(String(input));
    const page = Number(request.searchParams.get("page"));
    pages.push(page);
    const ids = page === 1 ? Array.from({ length: 100 }, (_, index) => String(index + 1)) : ["101"];
    return Response.json({ total_entries: 101, patients: ids.map(id => ({ id, archived_at: null,
      first_name: "private-canary", patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }] })) });
  };
  const created = ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5",
    contactEmail: "test@example.com" }, fetchPort);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const index = new PostgresPatientPhoneIndex(db);
  const lookup = new ClinikoPhoneLookup(created.value, index, "61", 60_000);
  assert.equal((await lookup.refresh(scope)).ok, true);
  assert.deepEqual(pages, [1, 2]);
  const found = await index.find(scope, "+61400111222", 60_000);
  assert.equal(found.ok && found.value.kind, "tooMany");
  const count = await db.selectFrom("patient_phone_index").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute();
  assert.equal(count.length, 101);
  assert.equal(JSON.stringify(count).includes("private-canary"), false);
  assert.equal((await index.clear(scope)).ok, true);
  assert.deepEqual(await index.find(scope, "+61400111222", 60_000),
    { ok: true, value: { kind: "stale", patientIds: [] } });
});

test("refresh worker scans outside calls, skips fresh generations, and shares concurrent ticks", async () => {
  const scope = { tenantId: "phone-worker-tenant", clinicId: "phone-worker-clinic" };
  let releaseFirst: (() => void) | undefined;
  const firstScan = new Promise<void>(resolve => { releaseFirst = resolve; });
  let scans = 0;
  const fetchPort: typeof fetch = async input => {
    assert.equal(new URL(String(input)).pathname, "/v1/patients");
    scans += 1;
    if (scans === 1) await firstScan;
    return Response.json({ total_entries: 1, patients: [{ id: "301", first_name: "private-worker-canary",
      archived_at: null, patient_phone_numbers: [{ number: "0400 555 777", phone_type: "Mobile" }] }] });
  };
  const created = ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5",
    contactEmail: "test@example.com" }, fetchPort);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const index = new PostgresPatientPhoneIndex(db);
  const lookup = new ClinikoPhoneLookup(created.value, index, "61", 60_000);
  let clock = new Date();
  const worker = new PhoneIndexRefreshWorker(index, [{ scope, lookup, refreshEveryMs: 60_000 }], () => clock);
  const first = worker.runOnce();
  const concurrent = worker.runOnce();
  releaseFirst!();
  assert.deepEqual(await first, [{ scope, kind: "refreshed" }]);
  assert.deepEqual(await concurrent, [{ scope, kind: "refreshed" }]);
  assert.equal(scans, 1);
  clock = new Date();
  assert.deepEqual(await worker.runOnce(), [{ scope, kind: "fresh" }]);
  assert.equal(scans, 1);
  const completed = await index.completedAt(scope);
  assert.equal(completed.ok && completed.value instanceof Date, true);
  if (!completed.ok || !completed.value) return;
  clock = new Date(completed.value.getTime() + 60_001);
  assert.deepEqual(await worker.runOnce(), [{ scope, kind: "refreshed" }]);
  assert.equal(scans, 2);
  const rows = await db.selectFrom("patient_phone_index").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute();
  assert.equal(JSON.stringify(rows).includes("private-worker-canary"), false);
  assert.deepEqual(rows.map(row => String(row.patient_id)), ["301"]);
});
