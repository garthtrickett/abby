import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { outboundRequestValue } from "../support/outbound-recipient-request.ts";
import { assertNotificationPrivacy } from "../support/outbound-notification-privacy.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { twilioNotificationRecoveryFixture } = await import(new URL("test/support/twilio-outbound-notification-recovery.js", emitted).href) as typeof import("../support/twilio-outbound-notification-recovery.ts");
const { PostgresOutboundCapacity } = await import(new URL("src/storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { outboundCapacityOwnerBinding, outboundContactGuardOwnerBinding } = await import(new URL("src/core/outbound-capacity.js", emitted).href) as typeof import("../../src/core/outbound-capacity.ts");

for (const crash of [false, true])
test(`emitted notification cold process needs no lost session/call/note IDs or private journal${crash ? " after real recovery SIGKILL" : ""}`, { timeout: 120000 }, async t => {
  const request = outboundRequestValue(), scope = { ...request.scope, tenantId: `notification-cold-${randomUUID()}` },
    patientId = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString();
  const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-outbound-au5", maxPerMinute: 180 }), until = Date.now() + 75000;
  while (await budget.checkHeadroom(40) !== null) { assert.ok(Date.now() < until, "wait only for actual native40 headroom"); await new Promise(r => setTimeout(r, 250)); }
  const f = await twilioNotificationRecoveryFixture({ request: { ...request, scope, patientId }, budget, effectsFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b) });
  const a = f.original.attempt, call = new PostgresOutboundCapacity(db, scope, outboundCapacityOwnerBinding(a.campaignRef)!),
    contact = new PostgresOutboundCapacity(db, scope, outboundContactGuardOwnerBinding(a.contactReferences!.guardRef)!);
  assert.equal(value(await call.acquireOnce(a.capacityAllocationRef!, 1)).kind, "acquired");
  assert.equal(value(await contact.acquireOnce(a.contactReferences!.allocationRef, 1)).kind, "acquired");
  const cwd = await mkdtemp(join(tmpdir(), "abby-notification-empty-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const nativeBefore = structuredClone([...f.native.rows]);
  const run = async (pause: boolean) => {
    const child = fork(new URL("../support/twilio-outbound-notification-worker.mjs", import.meta.url), [], { cwd, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" } });
    const output: string[] = []; child.stdout?.on("data", b => output.push(String(b))); child.stderr?.on("data", b => output.push(String(b)));
    const terminal = once(child, "exit"); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let ready!: () => void, done!: (v: unknown) => void, failed!: (e: Error) => void, observed = false;
    const reached = new Promise<void>(r => { ready = r; }), result = new Promise<unknown>((resolve, reject) => { done = resolve; failed = reject; }); result.catch(() => {});
    const timer = setTimeout(() => failed(Error("Synthetic notification child boundary unavailable")), 20000); t.after(() => clearTimeout(timer));
    child.once("error", () => failed(Error("Synthetic notification child unavailable")));
    child.on("message", async raw => {
      const m = raw as { kind: string; id: number; data: any }; let data: unknown; const signal = new AbortController().signal, p = f.recoveryPorts;
      if (m.kind === "workerError") { failed(Error("Synthetic notification child failed")); return; }
      if (m.kind === "result") { observed = true; done(m.data); return; }
      try {
        if (m.kind === "grant") {
          const q = m.data.query;
          if (m.data.family === "history") data = p.history.current(q, signal) && await p.history.allowsHistoryRead(q, signal);
          else if (m.data.family === "observation") data = p.history.current(q, signal) && await p.history.allowsObservationRead(q, signal);
          else if (m.data.family === "original") data = p.history.current(q, signal) && await p.history.allowsAttemptRead(q, signal);
          else if (m.data.family === "closure") data = p.closure.current(q, signal) && await p.closure.allows(q, signal);
          else if (m.data.family === "record") data = p.call.record.current(q, signal) && await p.call.record.allows(q, signal);
          else if (m.data.family === "call") data = p.call.authority.current(q, signal) && await p.call.authority.allows(q, signal);
          else throw Error("Synthetic grant unavailable");
        } else if (m.kind === "nativeFetch") {
          const r = m.data; assert.equal(r.method, "GET");
          const response = await p.native(r.input, { method: r.method, redirect: "error", signal, headers: r.headers });
          data = { body: await response.text(), status: response.status, headers: Object.fromEntries(response.headers) };
        } else if (m.kind === "providerFetch") {
          const r = m.data, u = new URL(r.input), root = `/2010-04-01/Accounts/${f.config.accountSid}/Calls`;
          assert.equal(r.method, "GET"); assert.equal(u.origin, "https://api.twilio.com");
          assert.equal(new Headers(r.headers).get("authorization"), `Basic ${Buffer.from(`${f.config.accountSid}:${f.config.authToken}`).toString("base64")}`);
          if (pause) { ready(); return; }
          let body: unknown;
          if (u.pathname === root + ".json") { assert.deepEqual(u.searchParams.getAll("ParentCallSid"), ["CA" + "2".repeat(32)]); const path = u.pathname + u.search;
            body = { calls: [], next_page_uri: null, previous_page_uri: null, page: 0, page_size: 100, uri: path, first_page_uri: path }; }
          else { assert.equal(u.pathname, root + "/CA" + "2".repeat(32) + ".json");
            body = { account_sid: f.config.accountSid, sid: "CA" + "2".repeat(32), from: f.config.from, to: f.payload.number, parent_call_sid: null,
              direction: "outbound-api", uri: u.pathname, status: "completed", date_created: "Sun, 01 Nov 2026 10:00:00 GMT", start_time: "Sun, 01 Nov 2026 10:00:05 GMT",
              end_time: "Sun, 01 Nov 2026 10:02:00 GMT", date_updated: "Sun, 01 Nov 2026 10:02:00 GMT" }; }
          data = { body: JSON.stringify(body), status: 200, headers: { "content-type": "application/json" } };
        } else throw Error("Synthetic remote operation unavailable");
      } catch { data = m.kind.endsWith("Fetch") ? { failed: true } : false; }
      if (child.connected) child.send({ kind: "reply", id: m.id, data }, () => {});
    });
    const strip = (v: object) => Object.fromEntries(Object.entries(v).filter(([k]) => !["clock", "now", "rateBudget", "contextKey"].includes(k)));
    const config = { ...f.recoveryConfig.call, maximumNativeRequests: 40, attempts: strip(f.recoveryConfig.call.attempts) };
    const start = { observations: strip(f.observations), call: config, carrier: strip(f.config), contextKey: f.config.contextKey.toString("base64"), key: f.key.toString("base64"),
      now: f.native.config.clock!(), binding: f.recoveryInput };
    for (const key of ["sessionActionRef", "reportActionRef", "callSid", "notificationRef"]) assert.equal(Object.hasOwn(start, key), false);
    child.send({ kind: "start", data: start });
    if (pause) { await Promise.race([reached, result.then(() => { throw Error("Synthetic child unexpectedly completed before crash boundary"); })]);
      assert.ok(child.kill("SIGKILL")); assert.deepEqual(await terminal, [null, "SIGKILL"]); assert.equal(observed, false); }
    else { assert.deepEqual(await result, { ok: true, value: { kind: "terminal", released: true } }); assert.deepEqual(await terminal, [0, null]); }
    clearTimeout(timer); assert.deepEqual(output, []); assert.deepEqual(await readdir(cwd), []);
  };
  if (crash) { await run(true); const before = (await sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id=${scope.tenantId}`.execute(db)).rows;
    assert.equal(before.length, 2); assert.ok(before.every(r => r.released_at === null)); }
  await run(false);
  const holds = (await sql<{ allocation_ref: string; released_at: Date | null }>`select allocation_ref,released_at from outbound_capacity_allocations where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.equal(holds.length, 2); assert.notEqual(holds.find(r => r.allocation_ref === a.capacityAllocationRef)!.released_at, null);
  assert.equal(holds.find(r => r.allocation_ref === a.contactReferences!.allocationRef)!.released_at, null);
  assert.deepEqual([...f.native.rows], nativeBefore); assert.equal(f.carrierRequests, 1); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
  await assertNotificationPrivacy(db, f, process.env.DATABASE_URL!);
});
