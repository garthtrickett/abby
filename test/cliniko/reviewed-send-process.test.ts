import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { sql } from "kysely";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoReviewRequest } from "../../src/cliniko/review-request.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

test("E2E-268 crash before, during and after the clinical send preserves discoverable review and never replays",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const databaseName = `abby_reviewed_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
  const scope = { tenantId: `reviewed-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
  const request: ClinikoReviewRequest = { scope, patientId: "917263544536271", businessId: "11",
    credentialFingerprint: clinikoCredentialFingerprint("synthetic-review-key-au5"), policyVersion: "reviewed-policy-canary",
    termsVersion: "reviewed-terms-canary", timeZone: "Asia/Jakarta", createdAt: "2026-10-04T04:00:00Z",
    operation: { kind: "cancel", appointmentId: "71", cancellationReason: 10, practitionerId: "22", appointmentTypeId: "33",
      startsAt: "2026-10-08T04:00:00Z", endsAt: "2026-10-08T04:30:00Z" } };
  const base = "https://api.au5.cliniko.com/v1";
  let checkpoint: "beforeMutation" | "duringMutation" | "afterMutation" = "beforeMutation";
  let row: Record<string, unknown> | undefined, recalls = 0, mutations = 0;
  let reached: () => void = () => undefined, serverFailure: unknown;
  const output: string[] = [], markers: string[] = [], children: ReturnType<typeof spawn>[] = [];
  const server = createServer((incoming, response) => {
    void (async () => {
      const url = new URL(incoming.url ?? "", "http://127.0.0.1");
      if (url.pathname === "/v1/recalls" && incoming.method === "POST") {
        recalls += 1; assert.equal(row, undefined);
        const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        markers.push(String(body.notes).split("\n")[0]!.slice("Abby request ".length));
        row = { id: "91", notes: body.notes, recalled: false, archived_at: null, recall_at: body.recall_at,
          patient: { links: { self: `${base}/patients/${body.patient_id}` } },
          recall_type: { links: { self: `${base}/recall_types/${body.recall_type_id}` } } };
        response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(row)); return;
      }
      if (url.pathname === "/v1/individual_appointments/71") {
        assert.equal(incoming.method, "PATCH"); assert.ok(row, "provider review precedes every mutation");
        mutations += 1;
        if (checkpoint === "duringMutation") { reached(); return; }
        response.writeHead(200, { "content-type": "application/json" }).end("{}"); return;
      }
      if (url.pathname === "/checkpoint") { assert.equal(incoming.method, "POST"); reached(); return; }
      assert.equal(url.pathname, "/v1/recalls"); assert.equal(incoming.method, "GET");
      assert.equal(url.searchParams.has("q[]"), false);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total_entries: row ? 1 : 0,
        recalls: row ? [row] : [] }));
    })().catch(error => { serverFailure = error; response.writeHead(500).end(); });
  });
  let db: ReturnType<typeof connectPostgres> | undefined, created = false;
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const proxy = `http://127.0.0.1:${address.port}`;
    const launch = (file: string, args: string[], input: unknown) => {
      const child = spawn(process.execPath, [file, ...args], { cwd: new URL("../../", import.meta.url),
        env: { DATABASE_URL: target.toString() }, stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(20_000) });
      children.push(child); let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      const exited = once(child, "exit").then(([code, signal]) => {
        output.push(stdout, stderr); return { code, signal, stdout, stderr };
      });
      child.stdin.end(JSON.stringify(input)); return { child, exited };
    };
    for (const phase of ["beforeMutation", "duringMutation", "afterMutation"] as const) {
      checkpoint = phase; row = undefined;
      const baselineMutations = mutations, baselineRecalls = recalls;
      const waiting = new Promise<void>(resolve => { reached = resolve; });
      const sender = launch("test/support/cliniko-reviewed-send-worker.ts", [], { request, proxy, checkpoint });
      await Promise.race([waiting, sender.exited.then(result => { throw new Error(`sender exited before checkpoint: ${result.code}`); })]);
      assert.equal(sender.child.kill("SIGKILL"), true); assert.equal((await sender.exited).signal, "SIGKILL");
      assert.equal(mutations - baselineMutations, phase === "beforeMutation" ? 0 : 1);
      const recovery = launch("test/support/cliniko-review-discovery-worker.ts", ["discover"], {
        scope: { tenantId: scope.tenantId, clinicId: scope.clinicId }, proxy, recallTypeId: "7" });
      const result = await recovery.exited; assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { pending: 1, invalid: 0, ambiguous: 0, book: 0, cancel: 1, reschedule: 0 });
      assert.equal(recalls - baselineRecalls, 1); assert.equal(mutations - baselineMutations, phase === "beforeMutation" ? 0 : 1);
    }
    assert.equal(serverFailure, undefined);
    const canaries = [request.patientId, request.policyVersion, request.termsVersion, request.operation.startsAt, ...markers]
      .map((value, index) => ({ label: `reviewed_${index}`, value }));
    assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
    for (const { value } of canaries) assert.ok(output.every(part => !part.includes(value)));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
