import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { classAttendanceFixture, classAttendee, classLink } from "../support/class-attendance.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";

for (const stage of ["review", "prepared", "during", "acknowledged"] as const)
  test(`E2E-392 actual class owner SIGKILL at ${stage} leaves provider review discoverable without a replacement send`,
    { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 75_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl), name = `abby_class_kill_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  const folder = await mkdtemp(join(tmpdir(), "abby-class-kill-")), scope = { tenantId: `class-kill-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const native = classAttendanceFixture({ scope, now: verificationNow, patientId: verificationCanaries[2]! });
  const recalls: Record<string, unknown>[] = [], mutations: string[] = [], children: ReturnType<typeof spawn>[] = [], output: string[] = [];
  let db: ReturnType<typeof connectPostgres> | undefined, created = false, posts = 0, held = false, checkpoint!: () => void;
  const ready = new Promise<void>(resolve => { checkpoint = resolve; });
  const server = createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url!, "http://synthetic.test"), method = incoming.method!;
      const send = (value: unknown, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
      if (url.pathname === "/owner-finished") { checkpoint(); return; }
      if (method !== "GET" && url.pathname.startsWith("/v1/")) mutations.push(`${method} ${url.pathname}`);
      if (stage === "prepared" && !held && recalls.length && method === "GET") { held = true; checkpoint(); return; }
      if (method === "POST") {
        const chunks: Buffer[] = []; for await (const part of incoming) chunks.push(Buffer.from(part));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (url.pathname === "/v1/recalls") {
          const row = { id: "71", notes: body.notes, recall_at: body.recall_at, recalled: false, archived_at: null,
            patient: classLink("patients", verificationCanaries[2]!), recall_type: classLink("recall_types", "7") };
          recalls.push(row); if (stage === "review") checkpoint(); else send(row, 201); return;
        }
        assert.equal(url.pathname, "/v1/attendees"); posts++;
        const row = { ...classAttendee("401", body.booking_id, body.patient_id), notes: body.notes };
        native.attendees.push(row); if (stage === "during") checkpoint(); else send(row, 201); return;
      }
      if (url.pathname === "/v1/recalls") { send({ recalls, total_entries: recalls.length }); return; }
      const result = await native.fetchPort(`https://api.au5.cliniko.com${url.pathname}${url.search}`, {
        method, redirect: "error", headers: incoming.headers as HeadersInit, signal: AbortSignal.timeout(5_000) });
      response.writeHead(result.status, { "Content-Type": "application/json" }).end(await result.text());
    } catch { if (!response.headersSent) response.writeHead(500).end(); }
  });
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const proxy = `http://127.0.0.1:${address.port}`;
    const launch = (mode: "send" | "recover") => {
      const child = spawn(process.execPath, ["test/support/class-booking-recovery-worker.ts"], {
        cwd: new URL("../../", import.meta.url), env: { DATABASE_URL: target.toString() }, stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(35_000) });
      children.push(child); let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += String(data); }); child.stderr.on("data", data => { stderr += String(data); });
      const exited = once(child, "exit").then(([code, signal]) => { output.push(stdout, stderr); return { code, signal, stdout, stderr }; });
      child.stdin.end(JSON.stringify({ mode, scope, proxy, ...(mode === "send" ? { folder } : {}) }));
      return { child, exited };
    };
    const owner = launch("send");
    await Promise.race([ready, owner.exited.then(result => { throw new Error(`owner exited before checkpoint: ${result.stderr}`); })]);
    assert.equal(owner.child.kill("SIGKILL"), true); assert.equal((await owner.exited).signal, "SIGKILL");
    const priorMutations = mutations.length, recovered = await launch("recover").exited;
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.deepEqual(JSON.parse(recovered.stdout), { pending: 1, valid: 1, clinicalWrites: 0, replayed: false });
    assert.equal(mutations.length, priorMutations, "fresh recovery must make no provider mutation");
    assert.equal(recalls.length, 1); assert.equal(recalls[0]!.recalled, false);
    assert.equal(posts, ["during", "acknowledged"].includes(stage) ? 1 : 0);
    const canaries = [...verificationCanaries, String(recalls[0]!.notes).split("\n")[0]!, "2026-10-08T10:00:00.000Z"]
      .map((value, index) => ({ label: `class_kill_${index}`, value }));
    assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
    assert.ok(output.every(text => canaries.every(canary => !text.includes(canary.value))));
    assert.deepEqual(await db.selectFrom("calls").selectAll().execute(), []);
    assert.deepEqual(await db.selectFrom("patient_phone_index").selectAll().execute(), []);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
    finally { await admin.destroy(); await rm(folder, { recursive: true, force: true }); }
  }
});
