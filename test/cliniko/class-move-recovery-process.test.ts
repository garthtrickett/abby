// E2E-419: cold staff process discovers clinical context in Cliniko, with no serialized caller authority.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { classMoveRecoveryFixture } from "../support/class-move-recovery.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import type { ClassMoveRecoveryStatus } from "../../src/standalone/cliniko-class-move-recovery.ts";

for (const variant of ["uncertainPassMoved", "ordinaryRestored"] as const)
test("E2E-419 fresh staff process inspects " + variant + " with PostgreSQL and backup privacy", {
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60000,
}, async () => {
  assert.ok(process.env.DATABASE_URL);
  const admin = connectPostgres(process.env.DATABASE_URL), name = "abby_recovery_" + randomUUID().replaceAll("-", "");
  const target = new URL(process.env.DATABASE_URL); target.pathname = "/" + name;
  await sql.raw('create database "' + name + '"').execute(admin);
  const db = connectPostgres(target.toString());
  let x: Awaited<ReturnType<typeof classMoveRecoveryFixture>> | undefined;
  const errors: string[] = [], traffic: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.ok(x); assert.equal(req.method, "GET");
      assert.equal(req.headers.authorization, "Basic " + Buffer.from("synthetic-class-au5:").toString("base64"));
      traffic.push(req.url!);
      const response = await x.f.config.fetchPort("https://api.au5.cliniko.com" + req.url, { method: "GET", redirect: "error",
        signal: new AbortController().signal, headers: { Authorization: req.headers.authorization!, "User-Agent": String(req.headers["user-agent"]) } });
      res.writeHead(response.status, { "Content-Type": "application/json" }); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { errors.push(error instanceof Error ? error.message : "synthetic provider failure"); res.writeHead(500); res.end(); }
  });
  try {
    await migrate(db);
    x = await classMoveRecoveryFixture(variant === "uncertainPassMoved", variant === "ordinaryRestored" ? "restored" : "moved", false,
      variant === "uncertainPassMoved" ? "association" : undefined);
    x.acknowledge(); x.elapse();
    const before = await x.f.state(), writes = x.f.writes.length, c = x.f.config;
    const source = resultValue(await c.sourcePolicy.current(x.f.scope)), destination = resultValue(await c.destinationPolicy.current(x.f.scope));
    const review = resultValue(decodeClinikoReview(x.f.recalls[0]!.notes));
    assert.equal(review.request.operation.kind, "classMove");
    if (review.request.operation.kind !== "classMove") throw new Error("synthetic movement required");
    const payload = String(x.f.recalls[0]!.notes).split("\n").find(line => line.startsWith("z1:")); assert.ok(payload);
    const caller = x.initial.mutation.request;
    assert.ok(caller.kind === "reschedule", "the synthetic caller owns a class move");
    // All values come from the synthetic parent; none is sent as worker authority.
    const canaries = [
      { label: "patient", value: caller.patient.patientRef },
      { label: "contact", value: "registered-session@example.test" },
      { label: "caller_grant", value: caller.patient.verificationRef },
      { label: "native_root", value: review.request.operation.attendanceActionId },
      { label: "email_code", value: x.f.mail[0]!.code },
      { label: "staff_grant_prefix", value: "staff-class-review:" },
      { label: "review_fragment", value: payload.slice(0, 200) },
      { label: "case", value: "811222333444555666" },
      { label: "entitlement", value: "private-move-source-entitlement" },
    ];
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
    const input = { scope: x.f.scope, proxy: "http://127.0.0.1:" + address.port,
      sourcePath: x.f.sourcePath, destinationPath: x.f.destinationPath, movePath: x.f.movePath, accountPath: x.f.accountPath,
      actorRef: x.f.account.actor.actorRef, policyVersion: c.policyVersion, businessId: c.cliniko.businessId, recallTypeId: source.recallTypeId,
      timeZone: source.timeZone, source: { practitionerId: source.practitionerId, appointmentTypeId: source.appointmentTypeId },
      destination: { practitionerId: destination.practitionerId, appointmentTypeId: destination.appointmentTypeId }, now: c.clock(),
      request: { ...x.request, ...(variant === "ordinaryRestored" ? { replacementAttendeeRef: "cliniko:attendee:401" } : {}) } };
    const serialized = JSON.stringify(input);
    for (const canary of canaries) assert.equal(serialized.includes(canary.value), false, "worker configuration contains private " + canary.label);
    const child = fork(new URL("../support/class-move-recovery-worker.ts", import.meta.url), [], { execArgv: [], stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...process.env, DATABASE_URL: target.toString() }, signal: AbortSignal.timeout(30000) });
    const closed = once(child, "close"); void closed.catch(() => {});
    let output = "", stderr = "";
    child.stdout!.on("data", chunk => { output += String(chunk); }); child.stderr!.on("data", chunk => { stderr += String(chunk); });
    try {
      child.stdin!.end(serialized);
      const [code] = await closed; assert.equal(code, 0, stderr || errors.join("\n"));
      const result = JSON.parse(output) as { kind: string; status: ClassMoveRecoveryStatus };
      assert.equal(result.kind, "coldReview"); assert.equal(result.status.kind, variant === "ordinaryRestored" ? "reviewedRestored" : "reviewedMoved");
      assert.equal(result.status.reviewAcknowledged, true);
      for (const canary of canaries) assert.equal((output + stderr).includes(canary.value), false, "worker output contains private " + canary.label);
      assert.deepEqual(errors, []); assert.ok(traffic.includes("/v1/recalls/71"));
      assert.equal(x.f.writes.length, writes); assert.deepEqual(await x.f.state(), before);
      const rows = await db.selectFrom("cliniko_request_budgets").selectAll().execute(); assert.equal(rows.length, 1);
      assert.ok(rows.every(row => row.max_per_minute === 180 && Array.isArray(row.sent_at_ms) && row.sent_at_ms.length > 0 && row.sent_at_ms.length <= 180));
      assert.equal((await db.selectFrom("cliniko_request_reservations").selectAll().execute()).length, 0);
      assert.deepEqual(resultValue(await scanPatientDataCanaries(db, canaries)), []);
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
  } finally {
    server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await x?.close(); await db.destroy();
    try { await sql.raw('drop database "' + name + '" with (force)').execute(admin); } finally { await admin.destroy(); }
  }
});
