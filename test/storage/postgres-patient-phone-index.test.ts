import assert from "node:assert/strict";
import test, { after } from "node:test";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { normalizePatientPhone } from "../../src/cliniko/phone-number.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoPhoneLookup } from "../../src/standalone/cliniko-phone-lookup.ts";
import { PhoneIndexRefreshWorker } from "../../src/standalone/phone-index-refresh-worker.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { PostgresPatientPhoneScan } from "../../src/storage/postgres-patient-phone-scan.ts";
import { PostgresPhoneRefreshGuard } from "../../src/storage/postgres-phone-refresh-guard.ts";

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
  const preserved = await index.find(scope, phone, 60_000, "61");
  assert.deepEqual(preserved, { ok: true, value: { kind: "stale", patientIds: [] } });
  const preservedRows = await db.selectFrom("patient_phone_index").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute();
  assert.equal(preservedRows.length, 2);
  const stale = await index.find(scope, phone, 60_000, "61", new Date(Date.now() + 120_000));
  assert.deepEqual(stale, { ok: true, value: { kind: "stale", patientIds: [] } });
  const otherClinic = await index.find({ ...scope, clinicId: "other-clinic" }, phone, 60_000, "61");
  assert.deepEqual(otherClinic, { ok: true, value: { kind: "stale", patientIds: [] } });
  assert.deepEqual(await lookup.candidates(scope, "withheld"), { ok: true, value: { kind: "noNumber", candidateIds: [] } });
});

test("candidate lookup discards IDs when disconnect, reconnect, or refresh wins during Cliniko recheck", async () => {
  for (const change of ["disconnect", "reconnect", "refresh"] as const) {
    const scope = { tenantId: `phone-candidate-race-${change}`, clinicId: "clinic" };
    const phone = "+61400111222";
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const fetchPort: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/patients") return Response.json({ total_entries: 1, patients: [
        { id: "101", archived_at: null, patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }] },
      ] });
      if (path === "/v1/patients/101") {
        entered();
        await held;
        return Response.json({ id: "101", archived_at: null,
          patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }] });
      }
      throw new Error("unexpected Cliniko request");
    };
    const reader = ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5",
      contactEmail: "test@example.com" }, fetchPort);
    assert.ok(reader.ok);
    const index = new PostgresPatientPhoneIndex(db);
    const lookup = new ClinikoPhoneLookup(reader.value, index, "61", 60_000);
    assert.deepEqual(await lookup.refresh(scope), { ok: true, value: 1 });
    const pending = lookup.candidates(scope, phone);
    await reading;
    if (change === "disconnect" || change === "reconnect") {
      assert.deepEqual(await index.clear(scope), { ok: true, value: true });
      if (change === "reconnect") {
        assert.deepEqual(await index.enable(scope), { ok: true, value: true });
        assert.deepEqual(await index.publish(scope, [{ normalizedPhone: phone, patientId: "101" }], "61", 1),
          { ok: true, value: 2 });
      }
    } else assert.deepEqual(await index.publish(scope, [{ normalizedPhone: phone, patientId: "102" }], "61", 1),
      { ok: true, value: 2 });
    release();
    assert.deepEqual(await pending, { ok: true, value: { kind: "indexStale", candidateIds: [] } });
    if (change === "reconnect") assert.deepEqual(await lookup.candidates(scope, phone),
      { ok: true, value: { kind: "one", candidateIds: ["101"] } });
  }
});

test("a failed or older concurrent scan cannot invalidate or replace a newer generation", async () => {
  const scope = { tenantId: "phone-race-tenant", clinicId: "phone-race-clinic" };
  const index = new PostgresPatientPhoneIndex(db);
  assert.deepEqual(await index.publish(scope, [{ normalizedPhone: "+61400111111", patientId: "401" }], "61"),
    { ok: true, value: 1 });
  let releaseFailed: (() => void) | undefined;
  let signalFailed: (() => void) | undefined;
  const failedGate = new Promise<void>(resolve => { releaseFailed = resolve; });
  const failedStarted = new Promise<void>(resolve => { signalFailed = resolve; });
  const makeReader = (fetchPort: typeof fetch) => {
    const created = ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5",
      contactEmail: "test@example.com" }, fetchPort);
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("reader expected");
    return created.value;
  };
  const failedLookup = new ClinikoPhoneLookup(makeReader(async () => {
    signalFailed!();
    await failedGate;
    return Response.json({ total_entries: 1, patients: [] });
  }), index, "61", 60_000);
  const winningLookup = new ClinikoPhoneLookup(makeReader(async () => Response.json({ total_entries: 1,
    patients: [{ id: "402", archived_at: null,
      patient_phone_numbers: [{ number: "0400 222 222", phone_type: "Mobile" }] }] })), index, "61", 60_000);
  const first = failedLookup.refresh(scope);
  await failedStarted;
  assert.deepEqual(await winningLookup.refresh(scope), { ok: true, value: 2 });
  releaseFailed!();
  assert.equal((await first).ok, false);
  assert.equal((await index.find(scope, "+61400222222", 60_000, "61")).ok, true);
  const head = await index.head(scope);
  assert.equal(head.ok && head.value?.generation, 2);
  const current = await index.find(scope, "+61400222222", 60_000, "61");
  assert.equal(current.ok && current.value.kind, "one");
  assert.deepEqual(current.ok ? current.value.patientIds : [], ["402"]);

  let releaseOlder: (() => void) | undefined;
  let signalOlder: (() => void) | undefined;
  const olderGate = new Promise<void>(resolve => { releaseOlder = resolve; });
  const olderStarted = new Promise<void>(resolve => { signalOlder = resolve; });
  const olderLookup = new ClinikoPhoneLookup(makeReader(async () => {
    signalOlder!();
    await olderGate;
    return Response.json({ total_entries: 1, patients: [{ id: "401", archived_at: null,
      patient_phone_numbers: [{ number: "0400 111 111", phone_type: "Mobile" }] }] });
  }), index, "61", 60_000);
  const older = olderLookup.refresh(scope);
  await olderStarted;
  assert.deepEqual(await winningLookup.refresh(scope), { ok: true, value: 3 });
  releaseOlder!();
  assert.deepEqual(await older, { ok: false, error: { kind: "generationChanged" } });
  const obsolete = await index.find(scope, "+61400111111", 60_000, "61");
  assert.equal(obsolete.ok && obsolete.value.kind, "none");
  const newest = await index.find(scope, "+61400222222", 60_000, "61");
  assert.equal(newest.ok && newest.value.kind, "one");
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
  const found = await index.find(scope, "+61400111222", 60_000, "61");
  assert.equal(found.ok && found.value.kind, "tooMany");
  const count = await db.selectFrom("patient_phone_index").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute();
  assert.equal(count.length, 101);
  assert.equal(JSON.stringify(count).includes("private-canary"), false);
  assert.equal((await index.clear(scope)).ok, true);
  assert.deepEqual(await index.find(scope, "+61400111222", 60_000, "61"),
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
  const worker = new PhoneIndexRefreshWorker(index, [{ scope, lookup, countryCallingCode: "61", refreshEveryMs: 60_000 }], () => clock);
  const first = worker.runOnce();
  const concurrent = worker.runOnce();
  releaseFirst!();
  assert.deepEqual(await first, [{ scope, kind: "refreshed" }]);
  assert.deepEqual(await concurrent, [{ scope, kind: "refreshed" }]);
  assert.equal(scans, 1);
  clock = new Date();
  assert.deepEqual(await worker.runOnce(), [{ scope, kind: "fresh" }]);
  assert.equal(scans, 1);
  const completed = await index.completedAt(scope, "61");
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

test("large Cliniko phone scan resumes its current page after the local rate budget resets", async () => {
  const scope = { tenantId: "phone-rate-tenant", clinicId: "phone-rate-clinic" };
  let clock = Date.parse("2026-09-29T00:00:00.000Z");
  const pages: number[] = [];
  const waits: string[] = [];
  const fetchPort: typeof fetch = async input => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    pages.push(page);
    const ids = page === 1 ? Array.from({ length: 100 }, (_, index) => String(index + 1)) : ["101"];
    return Response.json({ total_entries: 101, patients: ids.map(id => ({ id, archived_at: null,
      patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }] })) });
  };
  const created = ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5",
    contactEmail: "test@example.com", rateBudget: new ClinikoReadBudget(1, () => clock) },
  fetchPort, () => new Date(clock).toISOString());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const index = new PostgresPatientPhoneIndex(db);
  const lookup = new ClinikoPhoneLookup(created.value, index, "61", 60_000, async resetAt => {
    waits.push(resetAt);
    clock = Date.parse(resetAt);
  });
  assert.equal((await lookup.refresh(scope)).ok, true);
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(waits, ["2026-09-29T00:01:00.000Z"]);
  const rows = await db.selectFrom("patient_phone_index").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute();
  assert.equal(rows.length, 101);
});

test("full phone scan accepts more than ten thousand patients", async () => {
  const scope = { tenantId: "phone-large-tenant", clinicId: "phone-large-clinic" };
  const pages: number[] = [];
  const fetchPort: typeof fetch = async input => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    pages.push(page);
    const first = (page - 1) * 100 + 1;
    const last = Math.min(first + 99, 10_001);
    return Response.json({ total_entries: 10_001, patients: Array.from({ length: last - first + 1 }, (_, index) => ({
      id: String(first + index), archived_at: null,
      patient_phone_numbers: [{ number: "+61400111222", phone_type: "Mobile" }],
    })) });
  };
  const created = ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5",
    contactEmail: "test@example.com" }, fetchPort);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const index = new PostgresPatientPhoneIndex(db);
  const lookup = new ClinikoPhoneLookup(created.value, index, "61", 60_000);
  assert.deepEqual(await lookup.refresh(scope), { ok: true, value: 1 });
  assert.equal(pages.length, 101);
  const count = await db.selectFrom("patient_phone_index").select(db.fn.countAll<string>().as("count"))
    .where("tenant_id", "=", scope.tenantId as never).executeTakeFirstOrThrow();
  assert.equal(Number(count.count), 10_001);
});

test("interrupted phone scan resumes at the next page without publishing partial patient links", async () => {
  const scope = { tenantId: "phone-resume-tenant", clinicId: "phone-resume-clinic" };
  const index = new PostgresPatientPhoneIndex(db);
  const scan = new PostgresPatientPhoneScan(db);
  assert.deepEqual(await index.publish(scope, [{ normalizedPhone: "+61400999999", patientId: "900" }], "61"),
    { ok: true, value: 1 });
  const pages: number[] = [];
  let failSecondPage = true;
  const fetchPort: typeof fetch = async input => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    pages.push(page);
    if (page === 2 && failSecondPage) return new Response(null, { status: 503 });
    const ids = page === 1 ? Array.from({ length: 100 }, (_, offset) => String(offset + 1)) : ["101"];
    return Response.json({ total_entries: 101, patients: ids.map(id => ({
      id, first_name: "private-resume-canary", archived_at: null,
      patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }],
    })) });
  };
  const reader = () => {
    const created = ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5",
      contactEmail: "test@example.com" }, fetchPort);
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("reader expected");
    return created.value;
  };
  const first = new ClinikoPhoneLookup(reader(), index, "61", 60_000, undefined, scan);
  assert.deepEqual(await first.refresh(scope), { ok: false, error: { kind: "unavailable" } });
  assert.deepEqual(pages, [1, 2]);
  const checkpoint = await db.selectFrom("patient_phone_scan").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).executeTakeFirstOrThrow();
  assert.equal(checkpoint.next_page, 2);
  assert.equal(checkpoint.seen_count, 100);
  const staged = await db.selectFrom("patient_phone_scan_links").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute();
  assert.equal(staged.length, 100);
  assert.equal(JSON.stringify([checkpoint, staged]).includes("private-resume-canary"), false);
  const oldRows = await db.selectFrom("patient_phone_index").select("patient_id")
    .where("tenant_id", "=", scope.tenantId as never).execute();
  assert.deepEqual(oldRows.map(row => String(row.patient_id)), ["900"]);
  const stale = await index.find(scope, "+61400999999", 60_000, "61");
  assert.equal(stale.ok && stale.value.kind, "stale");

  failSecondPage = false;
  const restarted = new ClinikoPhoneLookup(reader(), new PostgresPatientPhoneIndex(db), "61", 60_000,
    undefined, new PostgresPatientPhoneScan(db));
  assert.deepEqual(await restarted.refresh(scope), { ok: true, value: 2 });
  assert.deepEqual(pages, [1, 2, 2]);
  const published = await db.selectFrom("patient_phone_index").select("patient_id")
    .where("tenant_id", "=", scope.tenantId as never).execute();
  assert.equal(published.length, 101);
  assert.equal(published.some(row => String(row.patient_id) === "900"), false);
  assert.equal((await db.selectFrom("patient_phone_scan").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute()).length, 0);
  assert.equal((await db.selectFrom("patient_phone_scan_links").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute()).length, 0);

  const pending = await scan.begin(scope, "61");
  assert.equal(pending.ok, true);
  if (!pending.ok) return;
  assert.deepEqual(await index.clear(scope), { ok: true, value: true });
  assert.deepEqual(await scan.finish(scope, pending.value.scanRef), { ok: false, error: { kind: "staleScan" } });
});

test("two worker processes coordinate one clinic scan and the losing worker retries after publication", async () => {
  const scope = { tenantId: "phone-owner-tenant", clinicId: "phone-owner-clinic" };
  const index = new PostgresPatientPhoneIndex(db);
  let releaseRead: (() => void) | undefined;
  let readStarted: (() => void) | undefined;
  const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  let reads = 0;
  const reader = ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5",
    contactEmail: "test@example.com" }, async () => {
    reads += 1;
    readStarted!();
    await heldRead;
    return Response.json({ total_entries: 1, patients: [{ id: "701", archived_at: null,
      patient_phone_numbers: [{ number: "0400 777 888", phone_type: "Mobile" }] }] });
  });
  assert.equal(reader.ok, true);
  if (!reader.ok) return;
  const lookup = new ClinikoPhoneLookup(reader.value, index, "61", 60_000,
    undefined, new PostgresPatientPhoneScan(db));
  const firstGuard = new PostgresPhoneRefreshGuard(url);
  const secondGuard = new PostgresPhoneRefreshGuard(url);
  const first = new PhoneIndexRefreshWorker(index, [{ scope, lookup, countryCallingCode: "61", refreshEveryMs: 60_000 }],
    undefined, firstGuard);
  const second = new PhoneIndexRefreshWorker(index, [{ scope, lookup, countryCallingCode: "61", refreshEveryMs: 60_000 }],
    undefined, secondGuard);
  const pending = first.runOnce();
  await started;
  assert.deepEqual(await second.runOnce(), [{ scope, kind: "busy" }]);
  assert.equal(reads, 1);
  releaseRead!();
  assert.deepEqual(await pending, [{ scope, kind: "refreshed" }]);
  assert.deepEqual(await second.runOnce(), [{ scope, kind: "fresh" }]);
  assert.equal(reads, 1);

  assert.deepEqual(await firstGuard.run(scope, async () => { throw new Error("synthetic worker crash"); }),
    { ok: false, error: { kind: "storageFailure" } });
  assert.deepEqual(await secondGuard.run(scope, async () => "next owner"),
    { ok: true, value: { kind: "ran", value: "next owner" } });
});

test("changing a clinic normalization plan blocks lookup until the index is rebuilt", async () => {
  const scope = { tenantId: "phone-plan-tenant", clinicId: "phone-plan-clinic" };
  const index = new PostgresPatientPhoneIndex(db);
  let listReads = 0;
  let patientReads = 0;
  const reader = ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5",
    contactEmail: "test@example.com" }, async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/patients") {
      listReads += 1;
      return Response.json({ total_entries: 1, patients: [{ id: "801", first_name: "private-plan-canary",
        archived_at: null, patient_phone_numbers: [{ number: "0400 888 999", phone_type: "Mobile" }] }] });
    }
    if (path === "/v1/patients/801") {
      patientReads += 1;
      return Response.json({ id: "801", archived_at: null,
        patient_phone_numbers: [{ number: "0400 888 999", phone_type: "Mobile" }] });
    }
    throw new Error("unexpected Cliniko request");
  });
  assert.equal(reader.ok, true);
  if (!reader.ok) return;
  const scan = new PostgresPatientPhoneScan(db);
  const australian = new ClinikoPhoneLookup(reader.value, index, "61", 60_000, undefined, scan);
  const newZealand = new ClinikoPhoneLookup(reader.value, index, "64", 60_000, undefined, scan);
  assert.deepEqual(await australian.refresh(scope), { ok: true, value: 1 });
  assert.deepEqual(await australian.candidates(scope, "0400 888 999"),
    { ok: true, value: { kind: "one", candidateIds: ["801"] } });
  assert.equal(patientReads, 1);
  assert.deepEqual(await newZealand.candidates(scope, "0400 888 999"),
    { ok: true, value: { kind: "indexStale", candidateIds: [] } });
  assert.equal(patientReads, 1);

  const worker = new PhoneIndexRefreshWorker(index, [{ scope, lookup: newZealand,
    countryCallingCode: "64", refreshEveryMs: 60_000 }]);
  assert.deepEqual(await worker.runOnce(), [{ scope, kind: "refreshed" }]);
  assert.equal(listReads, 2);
  assert.deepEqual(await newZealand.candidates(scope, "0400 888 999"),
    { ok: true, value: { kind: "one", candidateIds: ["801"] } });
  assert.deepEqual(await australian.candidates(scope, "0400 888 999"),
    { ok: true, value: { kind: "indexStale", candidateIds: [] } });
  const head = await index.head(scope);
  assert.equal(head.ok && head.value?.countryCallingCode, "64");
  assert.equal(head.ok && head.value?.normalizationVersion, 1);
  await db.updateTable("patient_phone_sync").set({ country_calling_code: null, normalization_version: null })
    .where("tenant_id", "=", scope.tenantId as never).execute();
  assert.deepEqual(await newZealand.candidates(scope, "0400 888 999"),
    { ok: true, value: { kind: "indexStale", candidateIds: [] } });
  assert.deepEqual(await worker.runOnce(), [{ scope, kind: "refreshed" }]);
  assert.equal(listReads, 3);
  await db.updateTable("patient_phone_sync").set({ normalization_version: 2 })
    .where("tenant_id", "=", scope.tenantId as never).execute();
  assert.deepEqual(await newZealand.candidates(scope, "0400 888 999"),
    { ok: true, value: { kind: "indexStale", candidateIds: [] } });
  assert.deepEqual(await worker.runOnce(), [{ scope, kind: "refreshed" }]);
  assert.equal(listReads, 4);
  const rows = await db.selectFrom("patient_phone_sync").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute();
  assert.equal(JSON.stringify(rows).includes("private-plan-canary"), false);
});

test("clinic disconnect fences future and in-flight phone refresh until explicit reconnect", async () => {
  const scope = { tenantId: "phone-disconnect-tenant", clinicId: "phone-disconnect-clinic" };
  const index = new PostgresPatientPhoneIndex(db);
  let releaseThirdRead: (() => void) | undefined;
  let thirdReadStarted: (() => void) | undefined;
  const heldRead = new Promise<void>(resolve => { releaseThirdRead = resolve; });
  const started = new Promise<void>(resolve => { thirdReadStarted = resolve; });
  let listReads = 0;
  const reader = ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5",
    contactEmail: "test@example.com" }, async () => {
    listReads += 1;
    if (listReads === 3) { thirdReadStarted!(); await heldRead; }
    return Response.json({ total_entries: 1, patients: [{ id: "901", archived_at: null,
      first_name: "private-disconnect-canary",
      patient_phone_numbers: [{ number: "0400 999 111", phone_type: "Mobile" }] }] });
  });
  assert.equal(reader.ok, true);
  if (!reader.ok) return;
  const lookup = new ClinikoPhoneLookup(reader.value, index, "61", 60_000,
    undefined, new PostgresPatientPhoneScan(db));
  const worker = new PhoneIndexRefreshWorker(index, [{ scope, lookup,
    countryCallingCode: "61", refreshEveryMs: 60_000 }]);
  assert.deepEqual(await worker.runOnce(), [{ scope, kind: "refreshed" }]);
  assert.deepEqual(await index.clear(scope), { ok: true, value: true });
  assert.deepEqual(await worker.runOnce(), [{ scope, kind: "disabled" }]);
  assert.equal(listReads, 1);
  assert.deepEqual(await lookup.refresh(scope), { ok: false, error: { kind: "clinicDisconnected" } });
  assert.deepEqual(await index.publish(scope, [{ normalizedPhone: "+61400999111", patientId: "901" }], "61"),
    { ok: false, error: { kind: "clinicDisconnected" } });
  const restarted = new PhoneIndexRefreshWorker(new PostgresPatientPhoneIndex(db), [{ scope, lookup,
    countryCallingCode: "61", refreshEveryMs: 60_000 }]);
  assert.deepEqual(await restarted.runOnce(), [{ scope, kind: "disabled" }]);
  assert.equal(listReads, 1);
  assert.equal((await db.selectFrom("patient_phone_index").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute()).length, 0);

  assert.deepEqual(await index.enable(scope), { ok: true, value: true });
  assert.deepEqual(await worker.runOnce(), [{ scope, kind: "refreshed" }]);
  assert.equal(listReads, 2);
  assert.deepEqual(await index.markStale(scope, 2), { ok: true, value: true });
  const inFlight = worker.runOnce();
  await started;
  assert.deepEqual(await index.clear(scope), { ok: true, value: true });
  releaseThirdRead!();
  assert.deepEqual(await inFlight, [{ scope, kind: "failed" }]);
  assert.deepEqual(await worker.runOnce(), [{ scope, kind: "disabled" }]);
  assert.equal(listReads, 3);
  assert.equal((await db.selectFrom("patient_phone_index").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute()).length, 0);
  assert.equal((await db.selectFrom("patient_phone_scan_links").selectAll()
    .where("tenant_id", "=", scope.tenantId as never).execute()).length, 0);
  assert.deepEqual(await index.find(scope, "+61400999111", 60_000, "61"),
    { ok: true, value: { kind: "stale", patientIds: [] } });
});
