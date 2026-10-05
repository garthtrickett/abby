import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { intakeDraft } from "../support/intake-edge.ts";
import { intakeBookingCanaries, intakeBookingProvider } from "../support/intake-booking-session.ts";

describe("E2E-296 parallel actual owner SIGKILL preserves patient and Cliniko review while replacement cannot replay booking",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", concurrency: 2 }, () => {
    for (const stage of ["beforeReview", "duringReview", "beforeSend", "duringSend", "afterSend"] as const) it(stage, { timeout: 90_000 }, async () => {
      const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
      const admin = connectPostgres(adminUrl), name = `abby_intake_booking_loss_${randomUUID().replaceAll("-", "")}`, target = new URL(adminUrl); target.pathname = `/${name}`;
      const folder = await mkdtemp(join(tmpdir(), "abby-intake-booking-kill-")), children: ReturnType<typeof spawn>[] = [], output: string[] = [];
      const provider = intakeBookingProvider(); let created = false, db: ReturnType<typeof connectPostgres> | undefined;
      let checkpoint: () => void = () => undefined, release: () => void = () => undefined;
      const ready = new Promise<void>(resolve => { checkpoint = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      if (stage === "duringReview") provider.onRecall(async () => { checkpoint(); await held; });
      if (stage === "beforeSend") provider.onContact(async () => { if (provider.recalls.length) { checkpoint(); await held; } });
      if (stage === "duringSend") provider.onBook(async () => { checkpoint(); await held; });
      const server = createServer(async (incoming, response) => {
        if (incoming.url === "/checkpoint") { checkpoint(); return; }
        try {
          let body = ""; for await (const part of incoming) body += String(part);
          const result = await provider.fetchPort(`https://api.au5.cliniko.com${incoming.url}`, { method: incoming.method!, redirect: "error", ...(body ? { body } : {}) });
          const text = await result.text(); if (!response.destroyed) response.writeHead(result.status, { "Content-Type": "application/json" }).end(text);
        } catch { if (!response.destroyed) response.writeHead(503).end(); }
      });
      try {
        await sql.raw(`create database "${name}"`).execute(admin); created = true; db = connectPostgres(target.toString()); await migrate(db);
        server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
        const proxy = `http://127.0.0.1:${address.port}`;
        async function launch(mode: string) {
          const owned = join(folder, mode); await mkdir(owned);
          const child = spawn(process.execPath, ["test/support/intake-booking-worker.ts"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: target.toString() }, stdio: ["pipe", "pipe", "pipe"] });
          children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on("data", part => output.push(String(part)));
          child.stdin.end(JSON.stringify({ mode, stage, proxy, folder: owned })); return child;
        }
        const sender = await launch("sender");
        let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([ready, new Promise<never>((_, reject) => sender.once("exit", () => reject(new Error("sender exited before checkpoint")))),
          new Promise<never>((_, reject) => { checkpointTimer = setTimeout(() => reject(new Error("checkpoint timeout")), 30_000); })]); }
        finally { if (checkpointTimer) clearTimeout(checkpointTimer); }
        const killed = once(sender, "exit"); sender.kill("SIGKILL"); assert.deepEqual(await killed, [null, "SIGKILL"]);
        release(); server.closeAllConnections(); const priorPatientPosts = provider.patientPosts, priorBookingPosts = provider.bookingPosts;
        assert.equal(priorPatientPosts, 1); assert.ok(provider.patient);
        assert.equal(provider.recalls.length, stage === "beforeReview" ? 0 : 1);
        assert.equal(priorBookingPosts, ["duringSend", "afterSend"].includes(stage) ? 1 : 0);
        const replacement = await launch("replacement"); assert.deepEqual(await once(replacement, "exit"), [0, null]);
        assert.equal(provider.patientPosts, priorPatientPosts); assert.equal(provider.bookingPosts, priorBookingPosts);
        assert.equal(!!provider.appointment, ["duringSend", "afterSend"].includes(stage));
        assert.ok(output.join("").includes(`"resumed":false,"mail":0,"replayed":false,"reviews":${stage === "beforeReview" ? 0 : 1}`));
        assert.equal(provider.traffic.some(value => /^(DELETE|PATCH)/.test(value)), false);
        const values = [...Object.values(intakeDraft), "private intake booking provider notes",
          ...provider.recalls.map(row => String(row.notes)), ...(provider.appointment ? [String(provider.appointment.notes), String(provider.appointment.starts_at)] : [])];
        const canaries = intakeBookingCanaries(values, "intake_booking_loss");
        for (let offset = 0; offset < canaries.length; offset += 12) {
          assert.deepEqual(await scanPatientDataCanaries(db, canaries.slice(offset, offset+12)), { ok: true, value: [] });
          assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries.slice(offset, offset+12)), []);
        }
        assert.ok(output.every(value => canaries.every(canary => !value.includes(canary.value))));
        assert.deepEqual(await db.selectFrom("calls").selectAll().execute(), []); assert.deepEqual(await db.selectFrom("patient_phone_index").selectAll().execute(), []);
      } finally {
        release(); for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGKILL"); await done; }
        server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(folder, { recursive: true, force: true }); await db?.destroy();
        try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); } finally { await admin.destroy(); }
      }
    });
  });
