import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { classPassMoveFixture } from "../support/class-pass-move.ts";

const url = process.env.DATABASE_URL;
async function withProvider(run: (environment: Awaited<ReturnType<typeof start>>) => Promise<void>) {
  const environment = await start(); try { await run(environment); } finally { await environment.close(); }
}
async function start() {
  assert.ok(url && process.env.ABBY_ISOLATED_POSTGRES_PROBE === "1", "isolated PostgreSQL required");
  const admin = connectPostgres(url!), name = `abby_stage_${randomUUID().replaceAll("-", "")}`, target = new URL(url!); target.pathname = `/${name}`;
  await sql.raw(`create database "${name}"`).execute(admin); const db = connectPostgres(target.toString()); await migrate(db);
  const f = await classPassMoveFixture({ history: 999, rosterHistory: 201 });
  const traffic: string[] = [], errors: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Basic ${Buffer.from("synthetic-class-au5:").toString("base64")}`);
      let body = ""; for await (const chunk of req) { body += String(chunk); if (body.length > 5000) throw new Error("body too large"); }
      const path = req.url!; traffic.push(`${req.method} ${new URL(path, "http://localhost").pathname}`);
      const response = await f.config.fetchPort(`https://api.au5.cliniko.com${path}`, { method: req.method!, redirect: "error", signal: new AbortController().signal,
        headers: { Authorization: req.headers.authorization!, "User-Agent": String(req.headers["user-agent"]), "Content-Type": "application/json" }, ...(body ? { body } : {}) });
      res.writeHead(response.status, { "Content-Type": "application/json" }); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { errors.push(error instanceof Error ? error.message : "provider failure"); res.writeHead(500); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const proxy = `http://127.0.0.1:${address.port}`;
  return { f, db, target: target.toString(), proxy, traffic, errors,
    async close() { f.lifetime.abort(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
      await db.destroy(); await sql.raw(`drop database "${name}"`).execute(admin); await admin.destroy(); } };
}
function worker(e: Awaited<ReturnType<typeof start>>, mode: "complete" | "park" | "discover") {
  const child = fork(new URL("../support/class-move-stages-worker.ts", import.meta.url), [mode], {
    execArgv: [], stdio: ["pipe", "ignore", "pipe", "ipc"], env: { ...process.env, DATABASE_URL: e.target },
  });
  const messages: Record<string, unknown>[] = []; let errors = "";
  child.on("message", m => { if (m && typeof m === "object") messages.push(m as Record<string, unknown>); });
  child.stderr!.on("data", b => { errors += String(b); });
  const exit = once(child, "exit");
  child.stdin!.end(JSON.stringify(mode === "discover" ? { scope: e.f.scope, proxy: e.proxy, recallTypeId: "7" } :
    { scope: e.f.scope, proxy: e.proxy, request: e.f.request, source: e.f.config.source, destination: e.f.config.destination, now: e.f.config.clock() }));
  return { child, messages, exit,
    async done() { const [code] = await exit; assert.equal(code, 0, errors || e.errors.join("\n")); },
    async until(kind: string) {
      const stop = Date.now() + 12000;
      while (!messages.some(m => m.kind === kind) && child.exitCode === null && Date.now() < stop) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(messages.some(m => m.kind === kind), `${kind}: ${errors || e.errors.join("\n")}`);
    },
    async kill() { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; } },
  };
}
async function privacy(e: Awaited<ReturnType<typeof start>>) {
  const notes = String(e.f.recalls[0]?.notes ?? ""), payload = notes.split("\n").find(s => s.startsWith("z1:")); assert.ok(payload);
  const canaries = [e.f.request.actionId, "private-class-proof", "synthetic-private-stage-proof-1", "synthetic-private-stage-proof-2", "synthetic-private-stage-proof-3", "source-entitlement", "destination-entitlement", "811222333444555666",
    ...Array.from({ length: Math.ceil(payload.length / 200) }, (_, i) => payload.slice(Math.min(i * 200, payload.length - 4), (i + 1) * 200))];
  const scan = await scanPatientDataCanaries(e.db, canaries.map((value, i) => ({ label: `stage_canary_${i}`, value }))); assert.equal(scan.ok, true); if (scan.ok) assert.deepEqual(scan.value, []);
}

test("E2E-417 real PostgreSQL quota windows admit four separate native phases without raising the account limit", { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 210000 }, async () => {
  await withProvider(async e => {
    const owner = worker(e, "complete");
    try {
      await owner.done(); const completed = owner.messages.find(m => m.kind === "completed"); assert.ok(completed);
      assert.equal(completed.phases, 4); assert.equal(completed.waits, 3);
      const stages = owner.messages.filter(m => m.kind === "stage"); assert.equal(stages.length, 4);
      assert.deepEqual(stages.map(m => m.next), ["original", "association", "associationInspection", undefined]);
      for (const stage of stages) { assert.equal(stage.held, 0); assert.ok(Array.isArray(stage.used) && stage.used.every(n => typeof n === "number" && n > 0 && n <= 180)); }
      assert.deepEqual(e.f.writes.map(w => w.leg), ["replacement", "original", "association"]); assert.equal(e.f.recalls.length, 1);
      assert.ok(owner.messages.filter(m => m.kind === "quotaWait").every(m => Number(m.milliseconds) >= 1 && Number(m.milliseconds) <= 60000));
      assert.deepEqual(e.errors, []); await privacy(e);
    } finally { await owner.kill(); }
  });
});

test("E2E-417 killing the staged sender leaves a native review discoverable using only clinic and account configuration", { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 30000 }, async () => {
  await withProvider(async e => {
    const owner = worker(e, "park");
    try {
      await owner.until("stage"); assert.equal(owner.messages.find(m => m.kind === "stage")!.next, "original"); await owner.kill();
      assert.deepEqual(e.f.writes.map(w => w.leg), ["replacement"]); assert.equal(e.f.original.cancelled_at, null);
      const before = e.traffic.length, recovery = worker(e, "discover");
      try {
        await recovery.done(); const result = recovery.messages.find(m => m.kind === "discovered"); assert.ok(result);
        assert.deepEqual(result, { kind: "discovered", pending: 1, stagedMoves: 1, invalid: 0 });
        assert.ok(e.traffic.slice(before).every(path => path === "GET /v1/recalls"));
        assert.deepEqual(e.f.writes.map(w => w.leg), ["replacement"]); await privacy(e);
      } finally { await recovery.kill(); }
    } finally { await owner.kill(); }
  });
});
