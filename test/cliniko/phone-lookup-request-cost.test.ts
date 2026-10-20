import assert from "node:assert/strict";
import test from "node:test";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import type { CompiledQuery, DatabaseConnection } from "kysely";
import type Database from "../../src/storage/generated/Database.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { PostgresClinikoContactRevision } from "../../src/storage/postgres-cliniko-contact-revision.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { PHONE_NORMALIZATION_VERSION } from "../../src/cliniko/phone-number.ts";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { clinikoRequestCeiling } from "../../src/cliniko/request-cost.ts";
import { ClinikoPhoneLookup } from "../../src/standalone/cliniko-phone-lookup.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { callerVerificationFixture } from "../support/caller-verification.ts";
import { CallerVerificationSession } from "../../src/standalone/caller-verification-session.ts";

/** Actual index SQL/transaction logic over an in-memory driver. Real PostgreSQL
 * execution and storage privacy remain separately required. */
function fixture(count: number) {
  const scope = { tenantId: "lookup-cost", clinicId: "clinic" }, phone = "+61400111222", fingerprint = clinikoCredentialFingerprint("synthetic-au5");
  let ids = Array.from({ length: count }, (_, i) => String(101 + i)), generation = 1, claims = 0;
  const requests: string[] = [], physical = new ClinikoReadBudget();
  const budget = { claim: () => { claims++; return physical.claim(); }, observe429: (header: string | null) => physical.observe429(header) };
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery) {
      const rows: unknown[] = query.sql.includes('from "patient_phone_clinic_status"') ? [{ enabled: true }] :
        query.sql.includes('from "patient_phone_sync"') ? [{ generation, completed_at: new Date(), country_calling_code: "61",
          normalization_version: PHONE_NORMALIZATION_VERSION, credential_fingerprint: fingerprint, contact_version: 0 }] :
        query.sql.includes("cliniko_contact_revisions") ? [{ version: 0, blocked: false }] :
        query.sql.includes('from "patient_phone_index"') ? ids.slice(0, 11).map(patient_id => ({ patient_id })) : [];
      return { rows: rows as R[] };
    },
    async *streamQuery() { throw new Error("unexpected streaming lookup"); },
  };
  class Driver extends DummyDriver { override async acquireConnection() { return connection; } }
  const db = new Kysely<Database>({ dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: database => new PostgresIntrospector(database), createQueryCompiler: () => new PostgresQueryCompiler() } });
  let around: ((signal: AbortSignal) => Promise<void>) | undefined, onlyFirstCurrent = false;
  const reader = resultValue(ClinikoPatientCandidateReader.create({ scope, apiKey: "synthetic-au5", contactEmail: "dev@example.test", rateBudget: budget },
    async (input, init) => {
      const id = new URL(String(input)).pathname.split("/").at(-1)!;
      requests.push(id); if (around) await around(init!.signal!);
      return Response.json({ id, archived_at: null, patient_phone_numbers: [{ number: onlyFirstCurrent && id !== "101" ? "+61400999888" : phone, phone_type: "Mobile" }] });
    }));
  const lookup = new ClinikoPhoneLookup(reader, new PostgresPatientPhoneIndex(db), "61", 60000);
  const binding = { scope, credentialFingerprint: fingerprint, budget }, lifetime = new AbortController();
  const revision = new PostgresClinikoContactRevision(db, scope.tenantId, [fingerprint], binding);
  return { scope, phone, reader, lookup, binding, lifetime, revision, requests, get claims() { return claims; },
    setCount(count: number) { ids = Array.from({ length: count }, (_, i) => String(101 + i)); },
    changeGeneration() { generation++; }, around(run: (signal: AbortSignal) => Promise<void>) { around = run; },
    onlyFirstCurrent() { onlyFirstCurrent = true; },
    async close() { lifetime.abort(); await db.destroy(); } };
}

for (const count of [0, 1, 3, 10]) test(`E2E-419 actual phone lookup bounds all ${count} indexed candidates without truncating ambiguity`, async () => {
  const f = fixture(count);
  try {
    const bound = await f.lookup.forVerificationBudget(f.binding, f.phone, f.lifetime.signal); assert.ok(bound);
    assert.equal(clinikoRequestCeiling(bound.candidates, f.binding), count);
    assert.equal(f.claims, 0, "the cost quote performs no native candidate read");
    const result = resultValue(await bound.candidates(f.scope, f.phone));
    assert.equal(result.kind, count === 0 ? "none" : count === 1 ? "one" : "multiple");
    assert.equal(result.candidateIds.length, count);
    assert.equal(f.claims, count); assert.equal(f.requests.length, count);
  } finally { await f.close(); }
});

for (const count of [1, 3, 10]) test(`E2E-419 actual composed patient proof covers all ${count} indexed phone reads and the separate native contact`, async () => {
  const f = fixture(count); f.onlyFirstCurrent();
  const caller = await callerVerificationFixture({ scope: { ...f.scope, locationId: "main" }, patientId: "101", apiKey: "synthetic-au5",
    operation: "appointments.reschedule", rateBudget: f.binding.budget, nativeRequestCosts: true, contactRevision: f.revision });
  let session: CallerVerificationSession | undefined;
  try {
    const lookup = await f.lookup.forVerificationBudget(f.binding, f.phone, f.lifetime.signal); assert.ok(lookup);
    caller.session.dispose();
    session = resultValue(CallerVerificationSession.create({ ...caller.sessionConfig, lookup }));
    assert.equal(clinikoRequestCeiling(f.revision.read, f.binding), 0);
    assert.deepEqual(session.nativeRequestCostCeilings(f.binding), { proof: count + 1, ownership: 0 });
    session.begin();
    const until = Date.now() + 5000;
    while (!caller.mail.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(caller.mail.length, 1); assert.equal((await session.submitCode(caller.mail[0]!.code)).verified, true);
    const before = f.claims, reads = f.requests.length;
    assert.ok(await session.verifiedSubject("appointments.reschedule"));
    assert.equal(f.claims - before, count + 1, "measure the complete actual proof, rather than assuming one lookup request");
    assert.equal(f.requests.length - reads, count);
  } finally { session?.dispose(); await caller.close(); await f.close(); }
});

test("E2E-419 growth beyond a phone lookup quote refuses before any native claim and a fresh quote covers every candidate", async () => {
  const f = fixture(1);
  try {
    const old = await f.lookup.forVerificationBudget(f.binding, f.phone, f.lifetime.signal); assert.ok(old);
    f.setCount(3);
    assert.equal((await old.candidates(f.scope, f.phone)).ok, false);
    assert.equal(f.claims, 0); assert.equal(f.requests.length, 0);
    const fresh = await f.lookup.forVerificationBudget(f.binding, f.phone, f.lifetime.signal); assert.ok(fresh);
    assert.equal(clinikoRequestCeiling(fresh.candidates, f.binding), 3);
    assert.equal(resultValue(await fresh.candidates(f.scope, f.phone)).kind, "multiple");
    assert.equal(f.claims, 3); assert.equal(f.requests.length, 3);
  } finally { await f.close(); }
});

test("E2E-419 bounded phone lookup retains the native/index generation race refusal", async () => {
  const f = fixture(1);
  try {
    const bound = await f.lookup.forVerificationBudget(f.binding, f.phone, f.lifetime.signal); assert.ok(bound);
    f.around(async () => { f.changeGeneration(); });
    assert.deepEqual(resultValue(await bound.candidates(f.scope, f.phone)), { kind: "indexStale", candidateIds: [] });
    assert.equal(f.claims, 1);
  } finally { await f.close(); }
});

test("E2E-419 phone lookup costs reject foreign budgets and changed native callbacks", async () => {
  const f = fixture(1);
  try {
    assert.equal(await f.lookup.forVerificationBudget({ ...f.binding, budget: new ClinikoReadBudget() }, f.phone, f.lifetime.signal), undefined);
    const bound = await f.lookup.forVerificationBudget(f.binding, f.phone, f.lifetime.signal); assert.ok(bound);
    const original = f.reader.hasCurrentPhone.bind(f.reader);
    f.reader.hasCurrentPhone = (...args) => original(...args);
    assert.equal((await bound.candidates(f.scope, f.phone)).ok, false);
    assert.equal(f.claims, 0); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("E2E-419 a proof cancellation aborts an in-flight phone read and prevents reading the remaining candidates", async () => {
  const f = fixture(3), stop = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const bound = await f.lookup.forVerificationBudget(f.binding, f.phone, f.lifetime.signal); assert.ok(bound);
    let observed: AbortSignal | undefined;
    f.around(signal => new Promise<void>((_resolve, reject) => {
      observed = signal; signal.addEventListener("abort", () => reject(new Error("synthetic aborted read")), { once: true }); entered();
    }));
    const pending = bound.candidates(f.scope, f.phone, stop.signal);
    await started; stop.abort();
    assert.equal((await pending).ok, false); assert.equal(observed?.aborted, true);
    assert.equal(f.claims, 1); assert.equal(f.requests.length, 1);
  } finally { stop.abort(); await f.close(); }
});
