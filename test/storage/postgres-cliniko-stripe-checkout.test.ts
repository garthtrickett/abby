import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { ClinikoFinancialWorkDiscovery } from "../../src/cliniko/financial-work-discovery.ts";
import { checkoutFixture, value, now, stop } from "../support/financial-checkout-owner.ts";
import { intentValue } from "../support/financial-retention.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(async () => { await db.destroy(); });
async function setup() {
  const source = intentValue(), intent = { ...source, scope: { ...source.scope, tenantId: `co-${randomUUID()}` }, actionRef: randomUUID(),
    booking: { ...source.booking, actionRef: randomUUID() }, effects: { checkout: randomUUID(), linkDelivery: randomUUID(), receiptDelivery: randomUUID(), checkoutExpiry: randomUUID(), clinicalExpiry: randomUUID() } };
  return checkoutFixture({ native: { intent, barrierFactory: config => new PostgresFinancialEffectBarrier(db, config.scope, value(financialRecordOwnerBinding(config))) } });
}
async function privacy(f: Awaited<ReturnType<typeof setup>>) {
  const rows = (await sql<Record<string, unknown>>`select * from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId}`.execute(db)).rows;
  assert.ok(rows.some(r => r.effect_ref === f.intent.effects.checkout));
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["claimed_at", "clinic_id", "effect_ref", "location_id", "owner_binding", "tenant_id"]);
  assert.deepEqual(await scanPatientDataCanaries(db, [
    { label: "native_patient", value: `/patients/${f.intent.patientId}` }, { label: "native_intent", value: f.binding.intentRecallRef },
    { label: "native_observation", value: f.binding.observationRecallRef }, { label: "stripe_ref", value: "cs_test_owner" },
    { label: "recipient", value: f.intent.recipient.address }, { label: "checkout_url", value: "https://checkout.stripe.com/c/pay/" },
    { label: "attempt_body", value: "Abby financial checkout attempt v1" }, { label: "quote_body", value: "Abby financial intent v1" },
  ]), { ok: true, value: [] });
}
test("real PostgreSQL concurrent financial owners create one payable and persist no private work", async () => {
  const f = await setup();
  const results = await Promise.all([f.owner.createOnce(f.binding, stop()), value(f.make()).createOnce(f.binding, stop())]);
  assert.equal(results.filter(r => r.ok && r.value.kind === "created").length, 1); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
  await privacy(f);
});
test("killed financial owner leaves durable provider attempt and burned SQL effect for fresh-owner recovery", async () => {
  const f = await setup();
  const child = fork(new URL("../support/financial-checkout-process.ts", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=384" } });
  let dispatched = false, resolveSent!: () => void, rejectSent!: (e: Error) => void;
  const sent = new Promise<void>((resolve, reject) => { resolveSent = resolve; rejectSent = reject; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.once("error", rejectSent);
  child.on("message", async (message: unknown) => {
    const m = message as { kind: string; id: number; data: { input: string; method: string; body?: string; headers: Record<string, string> } };
    try {
      if (m.kind === "fetch") {
        if (m.data.input === "https://api.stripe.com/v1/checkout/sessions" && m.data.method === "POST") {
          dispatched = true; resolveSent(); return; // Provider received; response is deliberately lost.
        }
        const response = await (m.data.input.startsWith("https://api.stripe.com/") ? f.stripePort : f.nativePort)(m.data.input,
          { method: m.data.method, headers: m.data.headers, ...(m.data.body ? { body: m.data.body } : {}), redirect: "error" });
        if (child.connected) child.send({ kind: "reply", id: m.id, data: { status: response.status, body: await response.text() } });
      } else if (m.kind === "claim") {
        if (child.connected) child.send({ kind: "reply", id: m.id, data: await f.config.cliniko.rateBudget.claim() });
      } else if (m.kind === "observe429") {
        if (child.connected) child.send({ kind: "reply", id: m.id, data: await f.config.cliniko.rateBudget.observe429(null) });
      } else if (m.kind === "workerError" || m.kind === "result") rejectSent(new Error("Worker finished before intended dispatch"));
    } catch (error) { rejectSent(error instanceof Error ? error : new Error("Fixture failure")); }
  });
  const { clock: _nativeClock, rateBudget: _rateBudget, producer, ...nativeConfig } = f.config.cliniko;
  const { clock: _stripeClock, ...stripe } = f.config.stripe;
  child.send({ kind: "start", now, binding: f.binding, config: { ...f.config, cliniko: { ...nativeConfig,
    producer: { keyRef: producer.keyRef, pem: producer.publicKey.export({ type: "spki", format: "pem" }).toString() } }, stripe } });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([sent, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Process dispatch deadline")), 20_000); })]);
    assert.equal(dispatched, true); assert.equal(child.killed, false); assert.ok(child.pid);
    assert.equal(child.kill("SIGKILL"), true); const terminal = await exited; assert.equal(terminal.signal, "SIGKILL");
    assert.ok([...f.rows.values()].some(r => String(r.notes).includes("financial checkout attempt")));
    const restarted = await value(f.make()).createOnce(f.binding, stop()); assert.equal(restarted.ok, false);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0); // No parent/restarted payable POST.
    const scanner = value(ClinikoFinancialWorkDiscovery.create(f.config.cliniko, { allowsAccountRead: async () => true, allowsRecordRead: async () => true, current: () => true }, f.nativePort));
    assert.equal(value(await scanner.scanPatient({ patientId: f.intent.patientId, createdFrom: f.intent.createdAt, createdThrough: now }, stop())).attempts.length, 1);
    await privacy(f);
  } finally {
    if (deadline) clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  }
});
