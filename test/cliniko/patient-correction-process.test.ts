import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresClinikoContactRevision } from "../../src/storage/postgres-cliniko-contact-revision.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { ClinikoPatientCorrectionRecovery } from "../../src/standalone/cliniko-patient-correction-recovery.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-366 SIGKILL before fence, during/after PATCH and after synchronization preserves review without replay", {
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000,
}, async () => {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl), name = `abby_correction_crash_${crypto.randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  const scope = { tenantId: `correction-crash-${crypto.randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const apiKey = "synthetic-session-au5", fp = clinikoCredentialFingerprint(apiKey), alias = clinikoCredentialFingerprint("synthetic-secondary-au5");
  const base = "https://api.au5.cliniko.com/v1", patientId = "482746192837465";
  const initial = { id: patientId, archived_at: null, merged_at: null, updated_at: "2026-10-04T06:00:00.000Z", links: { self: `${base}/patients/${patientId}` },
    first_name: "Synthetic", last_name: "Patient", date_of_birth: "1980-01-02", email: "registered-private@example.test",
    patient_phone_numbers: [{ number: "+61400111222", phone_type: "Mobile" }], address_1: "1 Example Road", address_2: null, address_3: null,
    city: "Example", state: "VIC", post_code: "3000", country_code: "AU", notes: "private-correction-chart-canary" };
  let patient = { ...initial }, row: Record<string, unknown> | undefined, phase = "", patches = 0, reviews = 0, serverFailure: unknown;
  const currentRow = () => row;
  let reached: () => void = () => {};
  const children: ReturnType<typeof spawn>[] = [], output: string[] = [];
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/checkpoint") { reached(); return; }
    if (url.pathname === "/v1/recalls" && request.method === "POST") {
      const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(chunks).toString()); reviews++;
      row = { id: "91", links: { self: `${base}/recalls/91` }, archived_at: null, recalled: false, updated_at: initial.updated_at,
        recall_at: body.recall_at, notes: body.notes, patient: { links: { self: `${base}/patients/${body.patient_id}` } }, recall_type: { links: { self: `${base}/recall_types/7` } } };
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(row)); return;
    }
    if (url.pathname === `/v1/patients/${patientId}`) {
      if (request.method === "PATCH") {
        const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
        const body = JSON.parse(Buffer.concat(chunks).toString()); assert.deepEqual(body, { post_code: "3999" });
        patches++; patient = { ...patient, ...body, updated_at: "2026-10-04T06:00:01.000Z" };
        if (phase === "duringSend") { reached(); return; }
      } else {
        assert.equal(request.method, "GET");
        if (row && (phase === "beforeFence" || phase === "afterSend" && patches > 0)) { reached(); return; }
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(patient)); return;
    }
    assert.equal(request.method, "GET");
    assert.ok(["/v1/recalls", "/v1/recalls/91"].includes(url.pathname));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(url.pathname === "/v1/recalls/91" ? row : { total_entries: row ? 1 : 0, recalls: row ? [row] : [] }));
  })().catch(error => { serverFailure = error; response.writeHead(500).end(); }); });
  let db: ReturnType<typeof connectPostgres> | undefined, created = false;
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
    const proxy = `http://127.0.0.1:${address.port}`;
    for (const step of ["beforeFence", "duringSend", "afterSend", "afterSync"] as const) {
      phase = step; row = undefined; patient = { ...initial }; patches = 0; reviews = 0;
      const waiting = new Promise<void>(resolve => { reached = resolve; });
      const child = spawn(process.execPath, ["test/support/patient-correction-process-worker.ts"], { cwd: new URL("../../", import.meta.url),
        env: { DATABASE_URL: target.toString(), ABBY_ISOLATED_POSTGRES_PROBE: "1" }, stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(30_000) });
      children.push(child); let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
      const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
      child.stdin.end(JSON.stringify({ scope, proxy, phase: step }));
      await Promise.race([waiting, exited.then(r => { throw new Error(`sender exited before checkpoint: ${r.code}; ${stderr}`); })]);
      assert.equal(child.kill("SIGKILL"), true); assert.equal((await exited).signal, "SIGKILL"); output.push(stdout, stderr);
      const recorded = currentRow(); assert.ok(recorded); const decoded = resultValue(decodeClinikoReview(recorded.notes)); assert.equal(decoded.request.operation.kind, "patientUpdate");
      if (decoded.request.operation.kind !== "patientUpdate") throw new Error("wrong correction review");
      const ref = decoded.request.operation.correctionRef;
      const contacts: PostgresClinikoContactRevision = new PostgresClinikoContactRevision(db, scope.tenantId, [fp, alias]);
      const status = resultValue(await contacts.status(ref));
      assert.equal(status?.status ?? null, step === "beforeFence" ? null : step === "afterSync" ? "completed" : "pending");
      assert.equal(patches, step === "beforeFence" ? 0 : 1); assert.equal(reviews, 1);
      const reader = resultValue(ClinikoRecallReader.create({ scope, apiKey, contactEmail: "test@example.test" }, (url, init) => {
        const u = new URL(String(url)); return fetch(`${proxy}${u.pathname}${u.search}`, init);
      }));
      const discovered = resultValue(await reader.discoverPendingReviews(scope, "7"));
      assert.equal(discovered.pending.length, 1); assert.equal(discovered.pending[0]!.kind, "review");
      if (step === "duringSend" || step === "afterSend") {
        assert.equal(resultValue(await contacts.read(fp)).blocked, true); assert.equal(resultValue(await contacts.read(alias)).blocked, true);
        row = { ...recorded, recalled: true, updated_at: "2026-10-04T06:00:02.000Z" };
        const actor = { actorRef: "recovery-admin", role: "clinicAdmin" as const, scope };
        const account = { actor, email: "admin@example.test", membershipVersion: "1" };
        const recovery = new ClinikoPatientCorrectionRecovery({ scope, businessId: "11", credentialFingerprint: fp, timeZone: "Australia/Sydney", recallTypeId: "7",
          reader, contacts, enabled: async () => true, directory: { findByRef: async () => ({ ok: true, value: account }), findByEmail: async () => ({ ok: true, value: account }) },
          authority: { currentActor: async () => actor, permitsReviewedResolution: async () =>
            child.signalCode === "SIGKILL" && patient.post_code === "3999" && row?.recalled === true } });
        resultValue(await recovery.resolve({ correctionRef: ref, recallRef: "cliniko:recall:91", reviewAcknowledged: true }));
        assert.equal(resultValue(await contacts.read(fp)).blocked, false);
      }
      assert.equal(patches, step === "beforeFence" ? 0 : 1); assert.equal(reviews, 1);
    }
    assert.equal(serverFailure, undefined);
    const canaries = [initial.email, initial.date_of_birth, initial.address_1, initial.notes];
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `correction_${i}`, value })))), []);
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries.map((value, i) => ({ label: `correction_${i}`, value }))), []);
    for (const value of canaries) assert.ok(output.every(part => !part.includes(value)));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await db?.destroy(); try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); } finally { await admin.destroy(); }
  }
});
