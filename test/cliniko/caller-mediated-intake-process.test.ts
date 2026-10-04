import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { intakeDraft } from "../support/intake-edge.ts";

test("E2E-295 SIGKILL before/during/after actual patient creation loses volatile intake; a fresh owner cannot resume, promise a staff task or replay",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl); const admin = connectPostgres(adminUrl);
    try {
      for (const stage of ["before", "during", "after"] as const) {
        const name = `abby_intake_loss_${randomUUID().replaceAll("-", "")}`; const target: URL = new URL(adminUrl); target.pathname = `/${name}`;
        let created = false, db: ReturnType<typeof connectPostgres> | undefined;
        const folder = await mkdtemp(join(tmpdir(), "abby-intake-kill-")), children: ReturnType<typeof spawn>[] = [], output: string[] = [];
        let posts = 0, requests = 0, row: Record<string, unknown> | undefined, checkpoint: () => void = () => undefined;
        const ready = new Promise<void>(resolve => { checkpoint = resolve; });
        const server = createServer((incoming, response) => {
          const url = new URL(incoming.url!, "http://synthetic.test");
          const send = (body: unknown, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
          if (url.pathname.startsWith("/v1/")) requests++;
          if (url.pathname === "/v1/patients" && incoming.method === "GET") {
            if (stage === "before") checkpoint(); else send({ total_entries: 0, patients: [] }); return;
          }
          if (url.pathname === "/v1/patients" && incoming.method === "POST") {
            let body = ""; incoming.on("data", part => { body += String(part); }); incoming.on("end", () => {
              posts++; row = { ...JSON.parse(body), id: "42", archived_at: null, notes: "private intake provider notes" };
              if (stage === "during") checkpoint(); else send(row, 201);
            }); return;
          }
          if (url.pathname === "/v1/patients/42") { send(row); return; }
          if (url.pathname === "/owner-finished") { checkpoint(); return; }
          response.writeHead(404).end();
        });
        try {
          await sql.raw(`create database "${name}"`).execute(admin); created = true; db = connectPostgres(target.toString()); await migrate(db);
          server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
          const proxy = `http://127.0.0.1:${address.port}`;
          async function launch(mode: string) {
            const owned = join(folder, mode); await mkdir(owned);
            const child = spawn(process.execPath, ["test/support/caller-mediated-intake-worker.ts"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: target.toString() }, stdio: ["pipe", "pipe", "pipe"] });
            children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on("data", part => output.push(String(part)));
            child.stdin.end(JSON.stringify({ mode, proxy, folder: owned })); return child;
          }
          const sender = await launch("sender");
          await Promise.race([ready, new Promise<never>((_, reject) => sender.once("exit", () => reject(new Error("sender exited before checkpoint")))),
            new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("checkpoint timeout")), 30_000); timer.unref(); })]);
          const killed = once(sender, "exit"); sender.kill("SIGKILL"); assert.deepEqual(await killed, [null, "SIGKILL"]);
          server.closeAllConnections(); const originalRequests = requests;
          const replacement = await launch("replacement"); assert.deepEqual(await once(replacement, "exit"), [0, null]);
          assert.equal(requests, originalRequests, "a fresh owner has no saved intake to inspect or replay"); assert.equal(posts, stage === "before" ? 0 : 1);
          assert.equal(!!row, stage !== "before", "the provider retains creation despite lost Abby state");
          assert.ok(output.join("").includes('"resumed":false,"created":0,"mail":0,"replayed":false'));
          const canaries = [...Object.values(intakeDraft), "private intake provider notes"].map((value, index) => ({ label: `intake_loss_${index}`, value }));
          assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
          assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
          assert.ok(output.every(text => canaries.every(canary => !text.includes(canary.value))));
          assert.deepEqual(await db.selectFrom("calls").selectAll().execute(), []); assert.deepEqual(await db.selectFrom("patient_phone_index").selectAll().execute(), []);
        } finally {
          for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGKILL"); await done; }
          server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
          await rm(folder, { recursive: true, force: true }); await db?.destroy();
          if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin);
        }
      }
    } finally { await admin.destroy(); }
  });
