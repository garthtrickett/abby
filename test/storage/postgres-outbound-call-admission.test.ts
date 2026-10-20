import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { approvedSyntheticPolicy } from "../support/approved-voice.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import type { Admission, Result } from "../../src/core/model.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { PostgresLedger } = await import(new URL("storage/postgres-ledger.js", emitted).href) as typeof import("../../src/storage/postgres-ledger.ts");
const { CallRuntime } = await import(new URL("core/runtime.js", emitted).href) as typeof import("../../src/core/runtime.ts");
const now = "2026-11-01T10:00:00.000Z";
function value<T>(result: Result<T, { kind: string }>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind); return result.value;
}
function fixture() {
  const scope = { tenantId: `outbound-admission-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const policy = approvedSyntheticPolicy({ ...referenceDefaultPolicy(scope), automationEnabled: true });
  const ledger = new PostgresLedger(db, suggested => suggested, undefined, "unsafeReference");
  const callId = randomUUID();
  const admission = { direction: "outbound" as const, key: { accountRef: "synthetic-account", providerCallRef: randomUUID() },
    clinicNumber: "+61255550100", acceptedAt: now, deadline: "2026-11-01T10:00:30.000Z" };
  return { scope, policy, ledger, callId, admission };
}

test("compiled outbound SQL admission retains public roles through a cold session and exact duplicates", async () => {
  const f = fixture();
  assert.deepEqual(await new PostgresLedger(db).admit(f.callId, f.policy, f.admission),
    { ok: false, error: { kind: "invalidTransition" } }, "standalone rich call persistence stays disabled");
  const admitted = value(await f.ledger.admit(f.callId, f.policy, f.admission));
  assert.equal(admitted.kind, "created"); assert.deepEqual(admitted.receipt.admission, f.admission);
  const cold = new PostgresLedger(db, suggested => suggested, undefined, "unsafeReference");
  const runtime = new CallRuntime(cold, f.scope);
  const active = value(await runtime.activate(f.callId, "outbound-session", now));
  assert.equal(active.lifecycle, "active"); assert.deepEqual(active.admission, f.admission);
  const lease = active.sessionLease!;
  value(await runtime.renewSession(f.callId, lease.sessionId, lease.version, now));
  assert.equal(value(await cold.admit(f.callId, f.policy, { ...f.admission, acceptedAt: "2026-11-01T10:00:01.000Z" })).kind, "duplicate");
  for (const other of [{ ...f.admission, clinicNumber: "+61255550101" },
    { key: f.admission.key, dialedNumber: f.admission.clinicNumber, acceptedAt: now, deadline: f.admission.deadline }]) {
    assert.deepEqual(await cold.admit(f.callId, f.policy, other), { ok: false, error: { kind: "callConflict" } });
  }
  const ended = value(await runtime.endCall(f.callId, "outbound-session", now));
  assert.equal(ended.lifecycle, "ended");
  assert.deepEqual(value(await cold.findAdmission(f.callId))?.admission, f.admission);
  const rows = await sql<{ payload: unknown }>`select payload from call_events where call_id = ${f.callId} and kind = 'callAdmitted'`.execute(db);
  assert.deepEqual(rows.rows.map(row => row.payload), [{ ...f.admission.key, direction: "outbound", clinicNumber: f.admission.clinicNumber }]);
});

test("compiled admission snapshots before SQL waits and rejects private or corrupt durable shapes", { timeout: 30000 }, async t => {
  const f = fixture(), privateNumber = "+61455550999", privatePatient = "482746192837465";
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let locked!: () => void;
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const blocking = db.transaction().execute(async trx => {
    await sql`select pg_advisory_xact_lock(hashtext(${f.callId}))`.execute(trx); locked(); await gate;
  });
  t.after(() => { release(); });
  await acquired;
  const requested = f.ledger.admit(f.callId, f.policy, f.admission);
  const through = Date.now() + 10000;
  for (;;) {
    const waiting = await sql<{ waiting: boolean }>`select exists(select 1 from pg_locks where locktype = 'advisory' and not granted
      and objid = ((hashtext(${f.callId})::bigint & 4294967295)::oid)) as waiting`.execute(db);
    if (waiting.rows[0]?.waiting) break;
    assert.ok(Date.now() < through, "admission must reach the actual held SQL lock");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // Mutate only after observing the real lock wait, before releasing it.
  Object.assign(f.admission, { recipientNumber: privateNumber, context: { patientId: privatePatient } });
  f.admission.key.providerCallRef = randomUUID();
  release(); await blocking;
  const admitted = value(await requested);
  assert.equal("recipientNumber" in admitted.receipt.admission, false);
  assert.notEqual(admitted.receipt.admission.key.providerCallRef, f.admission.key.providerCallRef);
  for (const extra of [{ dialedNumber: privateNumber }, { recipientNumber: privateNumber }, { context: { patientId: privatePatient } }]) {
    const start = fixture();
    assert.deepEqual(await start.ledger.admit(start.callId, start.policy, { ...start.admission, ...extra } as unknown as Admission),
      { ok: false, error: { kind: "invalidTransition" } });
    assert.equal(value(await start.ledger.findAdmission(start.callId)), null);
  }
  const original = value(await f.ledger.read(f.callId, f.scope));
  await sql`update calls set state = ${JSON.stringify({ ...original, admission: { ...original.admission, direction: "unsupported" } })}::jsonb where call_id = ${f.callId}`.execute(db);
  assert.deepEqual(await f.ledger.read(f.callId, f.scope), { ok: false, error: { kind: "storageCorrupt" } });
  await sql`update calls set state = ${JSON.stringify(original)}::jsonb where call_id = ${f.callId}`.execute(db);
  assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "recipient", value: privateNumber }, { label: "patient", value: privatePatient }]), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  assert.equal(dump.includes(privateNumber), false); assert.equal(dump.includes(privatePatient), false);
});
