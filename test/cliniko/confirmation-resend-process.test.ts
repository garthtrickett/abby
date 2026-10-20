import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresConfirmationResendJournal } from "../../src/storage/postgres-confirmation-resend-journal.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { DurableConfirmationSubmission } from "../../src/standalone/durable-confirmation-submission.ts";
import { SmtpAppointmentConfirmationDelivery } from "../../src/standalone/smtp-appointment-confirmation-delivery.ts";
import { ClinikoConfirmationResendRecovery } from "../../src/standalone/cliniko-confirmation-resend-recovery.ts";
import { OwnerFileConfirmationResendPolicy } from "../../src/standalone/owner-file-confirmation-resend-policy.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

test("E2E-377 SIGKILL at five resend checkpoints preserves honest cold receipts and permanent no-replay claims", {
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000,
}, async () => {
  const url = process.env.DATABASE_URL; assert.ok(url);
  const admin = connectPostgres(url), name = `abby_resend_crash_${crypto.randomUUID().replaceAll("-", "")}`;
  const target = new URL(url); target.pathname = `/${name}`;
  let db: ReturnType<typeof connectPostgres> | undefined, created = false;
  const children: ReturnType<typeof spawn>[] = [], folders: string[] = [], output: string[] = [];
  let row: Record<string, unknown> | undefined, reviews = 0, reached: () => void = () => {}, serverFailure: unknown;
  const base = "https://api.au5.cliniko.com/v1", currentRow = () => row;
  const server = createServer((request, response) => { void (async () => {
    if (request.url === "/checkpoint") { reached(); return; }
    if (request.method === "POST" && request.url === "/v1/recalls") {
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString()); reviews++;
      row = { id: "91", links: { self: `${base}/recalls/91` }, archived_at: null, recalled: false, updated_at: "2026-10-04T06:00:00.000Z",
        recall_at: body.recall_at, notes: body.notes, patient: { links: { self: `${base}/patients/${body.patient_id}` } }, recall_type: { links: { self: `${base}/recall_types/7` } } };
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(row)); return;
    }
    assert.equal(request.method, "GET"); assert.equal(request.url, "/v1/recalls/91");
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(row));
  })().catch(error => { serverFailure = error; response.writeHead(500).end(); }); });
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true; db = connectPostgres(target.toString()); await migrate(db);
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
    const proxy = `http://127.0.0.1:${address.port}`;
    for (const phase of ["beforeClaim", "afterClaim", "duringSend", "afterAcceptance", "afterFinish"] as const) {
      await withSmtpVerificationServer(async smtp => {
        row = undefined; reviews = 0; const waiting = new Promise<void>(done => { reached = done; });
        if (phase === "duringSend") smtp.fault("stallData");
        const folder = await mkdtemp(join(tmpdir(), "abby-resend-crash-")); folders.push(folder);
        const child = spawn(process.execPath, ["test/support/confirmation-resend-process-worker.ts"], { cwd: new URL("../../", import.meta.url),
          env: { DATABASE_URL: target.toString(), ABBY_ISOLATED_POSTGRES_PROBE: "1" }, stdio: ["pipe", "pipe", "pipe", "ipc"], signal: AbortSignal.timeout(30_000) });
        children.push(child); assert.ok(child.stdout && child.stderr && child.stdin); child.stdout.on("data", part => output.push(String(part))); child.stderr.on("data", part => output.push(String(part)));
        const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
        child.stdin.end(JSON.stringify({ proxy, phase, folder, smtp: { ...smtp.config, ca: Buffer.from(smtp.config.ca!).toString("utf8") } }));
        await Promise.race([phase === "duringSend" ? smtp.receivedData : waiting, exited.then(r => { throw new Error(`resend worker exited before checkpoint: ${r.code}`); })]);
        assert.equal(child.kill("SIGKILL"), true); assert.equal((await exited).signal, "SIGKILL");
        const recorded = currentRow(); assert.ok(recorded); const review = resultValue(decodeClinikoReview(recorded.notes)).request;
        assert.equal(review.operation.kind, "confirmationResend"); if (review.operation.kind !== "confirmationResend") throw new Error("wrong resend review");
        const ref = review.operation.resendRef, journal = new PostgresConfirmationResendJournal(db!, review.scope, review.termsVersion);
        const status = resultValue(await journal.read(ref));
        assert.equal(status?.kind ?? null, phase === "beforeClaim" ? null : phase === "afterFinish" ? "accepted" : "possiblySent");
        assert.equal(reviews, 1); assert.equal(smtp.messages.length, ["beforeClaim", "afterClaim"].includes(phase) ? 0 : 1);
        const approval = JSON.parse(await readFile(join(folder, "resend-approval.json"), "utf8")), directory = new OwnerFileAdminDirectory(join(folder, "accounts.json"), review.scope);
        const actor = JSON.parse(await readFile(join(folder, "accounts.json"), "utf8"))[0].actor;
        const policy = resultValue(await OwnerFileConfirmationResendPolicy.capture({ ...approval, path: join(folder, "resend-approval.json"), directory, clock: () => "2026-10-04T06:00:00.000Z" }));
        const reader = resultValue(ClinikoRecallReader.create({ scope: review.scope, apiKey: "synthetic-session-au5", contactEmail: "test@example.test" }, (value, init) => {
          const at = new URL(String(value)); return fetch(`${proxy}${at.pathname}`, init);
        }));
        const recovery = new ClinikoConfirmationResendRecovery({ scope: review.scope, businessId: "11", credentialFingerprint: review.credentialFingerprint, timeZone: "Australia/Sydney", recallTypeId: "7",
          reader, policy, directory, journalFor: binding => new PostgresConfirmationResendJournal(db!, review.scope, binding),
          authority: { currentActor: async () => actor, permitsReceiptInspection: async () => child.signalCode === "SIGKILL" } });
        const request = { requestRef: ref, recallRef: "cliniko:recall:91" };
        const recovered = resultValue(await recovery.inspect(request));
        assert.equal(recovered.kind, phase === "beforeClaim" ? "notRecorded" : phase === "afterFinish" ? "acceptedByMailService" : "unknown");
        row = { ...recorded, recalled: true }; assert.equal(resultValue(await recovery.inspect(request)).kind, recovered.kind);
        const commands = smtp.commands.length;
        if (phase !== "beforeClaim") {
          const restarted = new PostgresConfirmationResendJournal(db!, review.scope, review.termsVersion);
          assert.equal(resultValue(await restarted.claim(ref)).send, false);
          const result = await new DurableConfirmationSubmission(restarted, new SmtpAppointmentConfirmationDelivery(smtp.config)).submit(ref,
            { email: "registered-session@example.test", startsAt: "2026-10-08T04:00:00.000Z", endsAt: "2026-10-08T04:30:00.000Z",
              timeZone: "Australia/Sydney", clinicName: "Synthetic Clinic", locationName: "Synthetic Branch", locationAddress: "20 Fixture Road",
              practitionerName: "Séamus Example", appointmentTypeName: "Follow up" }, new AbortController().signal);
          assert.equal(result.kind, phase === "afterFinish" ? "accepted" : "unknown");
        }
        assert.equal(smtp.commands.length, commands); assert.equal(reviews, 1);
      });
    }
    assert.equal(serverFailure, undefined);
    const canaries = ["registered-session@example.test", "private-session-chart", "482746192837465", "20 Fixture Road", "Séamus Example"];
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `resend_${i}`, value })))), []);
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries.map((value, i) => ({ label: `resend_${i}`, value }))), []);
    for (const secret of canaries) assert.equal(output.some(text => text.includes(secret)), false);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done()));
    await db?.destroy(); try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); } finally { await admin.destroy(); }
    for (const folder of folders) await rm(folder, { recursive: true, force: true });
  }
});
