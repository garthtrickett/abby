import { compiledRuntimeEntrypoint } from "../support/compiled-runtime-entrypoint.ts";
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
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-290 killed actual admitted played-menu move owners leave discoverable Cliniko review before, during and after send without replacement replay",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  try {
    // Independent rehearsals own separate databases; sender and recovery share one real API-user bucket within each.
    for (const stage of ["before", "during", "after"] as const) {
      const name = `abby_move_kill_${randomUUID().replaceAll("-", "")}`;
      const target: URL = new URL(adminUrl); target.pathname = `/${name}`;
      let db: ReturnType<typeof connectPostgres> | undefined, created = false;
      try {
        await sql.raw(`create database "${name}"`).execute(admin); created = true;
        db = connectPostgres(target.toString()); await migrate(db);
        const folder = await mkdtemp(join(tmpdir(), "abby-move-kill-"));
        const patientId = verificationCanaries[2];
        const privateValues = verificationCanaries;
        const privateNote = verificationCanaries[1];
        const scope = { tenantId: `move-loss-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
        const recalls: Record<string, unknown>[] = [], base = "https://api.au5.cliniko.com/v1";
        const output: string[] = [], children: ReturnType<typeof spawn>[] = [];
        const providerMutations: string[] = [];
        let patches = 0, recallPosts = 0, stored: Record<string, unknown> = { id: "91", starts_at: "2026-10-08T04:00:00.000Z", ends_at: "2026-10-08T04:30:00.000Z", notes: privateNote,
          archived_at: null, deleted_at: null, cancelled_at: null,
          patient: { links: { self: `${base}/patients/${patientId}` } }, business: { links: { self: `${base}/businesses/11` } },
          practitioner: { links: { self: `${base}/practitioners/22` } }, appointment_type: { links: { self: `${base}/appointment_types/33` } } }, checkpoint: () => void = () => undefined;
        const ready = new Promise<void>(resolve => { checkpoint = resolve; });
        const server = createServer((incoming, response) => {
          const url = new URL(incoming.url!, "http://synthetic.test");
          if (incoming.method !== "GET" && url.pathname.startsWith("/v1/")) providerMutations.push(`${incoming.method} ${url.pathname}`);
          const send = (body: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body)); };
          if (url.pathname === `/v1/patients/${patientId}`) {
            send({ id: patientId, archived_at: null, email: verificationCanaries[0],
              patient_phone_numbers: [{ number: "+61400111222", phone_type: "Mobile" }], notes: privateNote }); return;
          }
          if (url.pathname === "/v1/individual_appointments/91" && incoming.method === "GET") { send(stored); return; }
          if (url.pathname === "/v1/individual_appointments/91/conflicts") { send({ conflicts: { exist: false } }); return; }
          if (url.pathname === "/v1/individual_appointments/91" && incoming.method === "PATCH") {
            let text = ""; incoming.on("data", part => { text += String(part); });
            incoming.on("end", () => {
              patches++; const body = JSON.parse(text);
              stored = { id: "91", starts_at: body.starts_at, ends_at: "2026-10-08T05:30:00.000Z", notes: privateNote,
                archived_at: null, deleted_at: null, cancelled_at: null,
                patient: { links: { self: `${base}/patients/${patientId}` } }, business: { links: { self: `${base}/businesses/11` } },
                practitioner: { links: { self: `${base}/practitioners/22` } }, appointment_type: { links: { self: `${base}/appointment_types/33` } } };
              if (stage === "during") checkpoint(); else send(stored, 200);
            }); return;
          }
          if (url.pathname === "/v1/recalls" && incoming.method === "GET") { send({ recalls, total_entries: recalls.length }); return; }
          if (url.pathname === "/v1/recalls" && incoming.method === "POST") {
            let text = ""; incoming.on("data", part => { text += String(part); });
            incoming.on("end", () => {
              recallPosts++; const body = JSON.parse(text);
              const row = { id: "71", notes: body.notes, recall_at: body.recall_at, recalled: false, archived_at: null,
                patient: { links: { self: `${base}/patients/${patientId}` } }, recall_type: { links: { self: `${base}/recall_types/7` } } };
              recalls.push(row);
              if (stage === "before") checkpoint(); else send(row, 201);
            }); return;
          }
          if (url.pathname === "/owner-finished" && incoming.method === "POST") { checkpoint(); return; }
          response.writeHead(404).end();
        });
        try {
          server.listen(0, "127.0.0.1"); await once(server, "listening");
          const address = server.address(); assert.ok(address && typeof address !== "string");
          const proxy = `http://127.0.0.1:${address.port}`;
          const launch = (mode: "send" | "recover") => {
            const child = spawn(process.execPath, [compiledRuntimeEntrypoint("test/support/standalone-rescheduling-worker.ts")], {
              cwd: new URL("../../", import.meta.url), env: { DATABASE_URL: target.toString() },
              stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(25_000) });
            children.push(child); let stdout = "", stderr = "";
            child.stdout.on("data", part => { stdout += String(part); }); child.stderr.on("data", part => { stderr += String(part); });
            const exited = once(child, "exit").then(([code, signal]) => { output.push(stdout, stderr); return { code, signal, stdout, stderr }; });
            child.stdin.end(JSON.stringify({ mode, scope, proxy, ...(mode === "send" ? { folder, session: true } : {}) })); return { child, exited };
          };
          const sender = launch("send");
          await Promise.race([ready, sender.exited.then(outcome => { throw new Error(`move owner exited before ${stage} checkpoint: ${outcome.stderr}`); })]);
          assert.equal(sender.child.kill("SIGKILL"), true); assert.equal((await sender.exited).signal, "SIGKILL");
          const sentBeforeRecovery = providerMutations.length;
          const budget = await db.selectFrom("cliniko_request_budgets").selectAll().execute();
          assert.equal(budget.length, 1); assert.ok(Array.isArray(budget[0]!.sent_at_ms));
          assert.ok(budget[0]!.sent_at_ms.length < 180, "fresh recovery has capacity; exhausted budget cannot explain no replay");
          const fresh = await launch("recover").exited; assert.equal(fresh.code, 0, fresh.stderr);
          assert.deepEqual(JSON.parse(fresh.stdout), { pending: 1, valid: 1, clinicalWrites: 0, replayed: false });
          assert.equal(providerMutations.length, sentBeforeRecovery, "replacement may not attempt any provider mutation");
          assert.equal(recallPosts, 1); assert.equal(patches, stage === "before" ? 0 : 1); assert.equal(recalls[0]!.recalled, false);
          const marker = String(recalls[0]!.notes).split("\n")[0]!;
          const canaries = [...privateValues, marker, "2026-10-08T04:00:00.000Z", "2026-10-08T05:00:00.000Z"].map((value, index) => ({ label: `kill_move_${index}`, value }));
          assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
          assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
          assert.ok(output.every(text => canaries.every(canary => !text.includes(canary.value))));
          assert.deepEqual(await db.selectFrom("calls").selectAll().execute(), []);
          assert.deepEqual(await db.selectFrom("patient_phone_index").selectAll().execute(), []);
        } finally {
          for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          server.closeAllConnections();
          if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
          await rm(folder, { recursive: true, force: true });
        }
      } finally {
        await db?.destroy();
        if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin);
      }
    }
  } finally { await admin.destroy(); }
});
