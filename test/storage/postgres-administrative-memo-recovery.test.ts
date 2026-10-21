import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { decodeAdministrativeMemo, administrativeMemoActionRef } from "../../src/cliniko/administrative-memo.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { PostgresPatientPhoneScan } from "../../src/storage/postgres-patient-phone-scan.ts";
import { PostgresOutboundEffectBarrier } from "../../src/storage/postgres-outbound-effect-barrier.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import type { AdministrativeMemoRecoverySelection } from "../../src/standalone/cliniko-administrative-memo-recovery.ts";

const worker = new URL("../../dist/runtime/test/support/administrative-memo-recovery-worker.js", import.meta.url);
for (const mode of ["stored", "archived", "unretained"] as const)
test(`actual admitted class sender SIGKILL, cold GET-only recovery and full logical restore: ${mode}`, { timeout: 240000 }, async () => {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl), names: string[] = [], children: ReturnType<typeof spawn>[] = [], output: string[] = [];
  const folder = await mkdtemp(join(tmpdir(), "abby-memo-cold-"));
  const scope = { tenantId: `memo-cold-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const patientId = verificationCanaries[2]!, mutations: string[] = [], reads: string[] = [];
  let db: ReturnType<typeof connectPostgres> | undefined, review: Record<string, unknown> | undefined,
    memo: Record<string, unknown> | undefined, senderFolder: string | undefined;
  let settings: { key: string; businessId: string; authorRef: string; policy: { version: string; digest: string }; now: string;
    selection: AdministrativeMemoRecoverySelection } | undefined;
  const privateValues: string[] = []; let clinicalDone!: () => void, memoDone!: () => void;
  const clinical = new Promise<void>(resolve => { clinicalDone = resolve; }), received = new Promise<void>(resolve => { memoDone = resolve; });
  const native = "https://api.au5.cliniko.com/v1";
  const server = createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url!, "http://synthetic.test"), method = incoming.method!;
      const send = (value: unknown) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
      let body: Record<string, any> = {};
      if (method === "POST") { const chunks: Buffer[] = []; for await (const part of incoming) chunks.push(Buffer.from(part)); body = JSON.parse(Buffer.concat(chunks).toString()); }
      if (url.pathname === "/sender-ready") {
        assert.equal(settings, undefined); senderFolder = body.folder;
        assert.equal(typeof senderFolder, "string"); assert.ok(senderFolder!.startsWith(tmpdir() + "/"));
        settings = { key: body.key, businessId: body.businessId, authorRef: body.authorRef, policy: body.policy, now: "",
          selection: { patientId, recallRef: "cliniko:recall:71", createdFrom: "", createdThrough: "" } };
        privateValues.push(body.key, body.callId, body.sessionId);
      } else if (url.pathname === "/mirror-native") {
        assert.ok(["/v1/recalls", "/v1/attendees"].includes(body.path)); mutations.push(`POST ${body.path}`);
        if (body.path === "/v1/recalls") {
          assert.equal(review, undefined); const decoded = decodeClinikoReview(body.row.notes); assert.ok(decoded.ok);
          review = { ...body.row, links: { self: `${native}/recalls/71` }, created_at: decoded.value.request.createdAt, updated_at: decoded.value.request.createdAt };
          assert.equal(decoded.value.request.operation.kind, "classBook");
          privateValues.push(String(body.row.notes), decoded.value.marker, decoded.value.request.operation.attendanceActionId);
        } else { assert.ok(review); privateValues.push(JSON.stringify(body.row)); }
      } else if (url.pathname === "/clinical-finished") {
        assert.ok(settings); settings.now = body.now;
        settings.selection = { ...settings.selection, createdFrom: new Date(Date.parse(body.now) - 3600000).toISOString(), createdThrough: body.now };
        privateValues.push(body.code, body.proof); clinicalDone();
      } else if (url.pathname === "/v1/communications" && method === "POST") {
        assert.ok(settings); assert.equal(memo, undefined); mutations.push("POST /v1/communications");
        const decoded = decodeAdministrativeMemo(body.content); assert.ok(decoded.ok); const at = decoded.value.recordedAt;
        memo = { ...body, id: "701", patient: { links: { self: `${native}/patients/${patientId}` } }, links: { self: `${native}/communications/701` },
          created_at: at, updated_at: at, archived_at: mode === "archived" ? at : null };
        privateValues.push(String(body.content), decoded.value.authentication, JSON.stringify(body)); memoDone();
        return; // Lose the exact native response by killing the requesting owner.
      } else if (method === "GET" && url.pathname === "/v1/recalls/71") { reads.push(url.pathname); assert.ok(review); send(review); return; }
      else if (method === "GET" && url.pathname === "/v1/communications") {
        reads.push(url.pathname); assert.ok(settings);
        assert.deepEqual(url.searchParams.getAll("q[]"), [`patient_id:=${patientId}`, "category_code:=12", "type_code:=3", "archived_at:*",
          `created_at:>=${settings.selection.createdFrom}`, `created_at:<=${settings.selection.createdThrough}`]);
        assert.equal(url.searchParams.get("sort"), "id:asc"); assert.equal(url.searchParams.get("per_page"), "100");
        const humans = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), content: "Unrelated clinic memo", confidential: false,
          category_code: 12, type_code: 3, direction_code: 2, archived_at: null, created_at: settings!.now, updated_at: settings!.now,
          links: { self: `${native}/communications/${i + 1}` }, patient: { links: { self: `${native}/patients/${patientId}` } } }));
        const all = mode === "unretained" ? humans : [...humans, memo!], page = Number(url.searchParams.get("page"));
        assert.ok(page === 1 || page === 2); send({ communications: all.slice((page - 1) * 100, page * 100), total_entries: all.length }); return;
      } else assert.fail("unexpected synthetic provider request");
      response.writeHead(204).end();
    } catch { if (!response.headersSent) response.writeHead(500).end(); }
  });
  try {
    const create = async () => { const name = `abby_memo_cold_${randomUUID().replaceAll("-", "")}`;
      await sql.raw(`create database "${name}"`).execute(admin); names.push(name); const url = new URL(adminUrl); url.pathname = `/${name}`; return url.toString(); };
    const target = await create(); db = connectPostgres(target); await migrate(db);
    const unrelated = { tenantId: `unrelated-${randomUUID()}`, clinicId: "index", locationId: "main" }, binding = "e".repeat(64), retainedRef = randomUUID();
    const links = [{ normalizedPhone: "+61400111222", patientId: "101" }];
    assert.ok((await new PostgresPatientPhoneIndex(db).publish(unrelated, links, "61", binding)).ok);
    const scans = new PostgresPatientPhoneScan(db), staged = { ...unrelated, clinicId: "staged" }, scan = await scans.begin(staged, "61", binding); assert.ok(scan.ok);
    assert.ok((await scans.append(staged, scan.value.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok);
    assert.ok((await new PostgresOutboundEffectBarrier(db, unrelated, binding).claimOnce(retainedRef)).ok);
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
    const proxy = `http://127.0.0.1:${address.port}`;
    const launch = (mode: "send" | "recover", database: string) => {
      const child = spawn(process.execPath, [worker.pathname], { cwd: folder, env: { DATABASE_URL: database, NODE_OPTIONS: "--max-old-space-size=384" },
        stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(200000) }); children.push(child);
      let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
      const terminal = once(child, "exit").then(([code, signal]) => { output.push(stdout, stderr); return { code, signal, stdout, stderr }; });
      child.stdin.end(JSON.stringify({ mode, scope, proxy, ...(mode === "recover" ? { settings } : {}) })); return { child, terminal };
    };
    const sender = launch("send", target);
    await Promise.race([Promise.all([clinical, received]), sender.terminal.then(result => { throw Error(`sender ended before held native response: ${result.stderr}`); })]);
    assert.ok(settings?.now); assert.equal(sender.child.kill("SIGKILL"), true); assert.equal((await sender.terminal).signal, "SIGKILL");
    assert.throws(() => process.kill(sender.child.pid!, 0), { code: "ESRCH" });
    assert.deepEqual(mutations, ["POST /v1/recalls", "POST /v1/attendees", "POST /v1/communications"]);
    const original = decodeClinikoReview(review!.notes); assert.ok(original.ok && original.value.request.operation.kind === "classBook");
    const purpose = administrativeMemoActionRef(original.value.request.operation.attendanceActionId)!;
    assert.equal((await sql`select * from outbound_effect_barriers where tenant_id=${scope.tenantId} and effect_ref=${purpose}::uuid`.execute(db)).rows.length, 1);
    // The actual account budget remains 180. If the sender exhausted this real
    // minute, wait for its SQL-owned reset rather than edit rows or raise quota.
    const quota = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-class-au5", maxPerMinute: 180 });
    const wait = await quota.checkHeadroom(10); if (wait) {
      assert.equal(wait.kind, "rateLimited"); assert.ok(wait.resetAt);
      await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, Date.parse(wait.resetAt!) - Date.now()) + 25));
    }
    const recover = async (database: string) => {
      const before = mutations.length, previousReads = reads.length, result = await launch("recover", database).terminal;
      assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null);
      assert.deepEqual(JSON.parse(result.stdout), { kind: mode === "unretained" ? "notLocated" : "located", scanned: mode === "unretained" ? 100 : 101, spent: true, replayed: false });
      assert.equal(mutations.length, before); assert.equal(reads.length - previousReads, mode === "unretained" ? 3 : 5);
    };
    await recover(target);
    const canaries = [...verificationCanaries, ...privateValues, "private-class-shared-note", "private-attendee-note", "2026-10-08T10:00:00.000Z"].filter(v => v.length >= 4);
    const check = async (database: string, connection: NonNullable<typeof db>) => {
      const chunks = canaries.flatMap((v, i) => Array.from({ length: Math.ceil(v.length / 256) }, (_, n) => ({ label: `cold_${i}_${n}`, value: v.slice(n * 256, (n + 1) * 256).length < 4 ? v.slice(-4) : v.slice(n * 256, (n + 1) * 256) })));
      for (let i = 0; i < chunks.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(connection, chunks.slice(i, i + 12)), { ok: true, value: [] });
      const dump = execFileSync("pg_dump", [database, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
      const copy = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
      for (const raw of canaries) { const json = JSON.stringify(raw).slice(1, -1); for (const candidate of [raw, copy(raw), json, copy(json)]) assert.equal(dump.includes(candidate), false); }
      assert.equal(dump.includes(retainedRef), true); assert.equal((await connection.selectFrom("patient_phone_index").selectAll().execute()).length, 1);
      assert.equal((await connection.selectFrom("patient_phone_scan").selectAll().execute()).length, 1);
      assert.deepEqual(await connection.selectFrom("calls").selectAll().execute(), []);
      const windows = await connection.selectFrom("cliniko_request_budgets").selectAll().execute(); assert.equal(windows.length, 1);
      assert.equal(windows[0]!.max_per_minute, 180); const timestamps: unknown = windows[0]!.sent_at_ms; assert.ok(Array.isArray(timestamps) && timestamps.length <= 180);
      return dump;
    };
    const dump = await check(target, db), restoredUrl = await create();
    execFileSync("psql", [restoredUrl, "-v", "ON_ERROR_STOP=1", "-q"], { input: dump, timeout: 10000, maxBuffer: 8000000 });
    const restored = connectPostgres(restoredUrl);
    try {
      assert.deepEqual(await restored.selectFrom("outbound_effect_barriers").selectAll().orderBy("effect_ref").execute(), await db.selectFrom("outbound_effect_barriers").selectAll().orderBy("effect_ref").execute());
      await recover(restoredUrl); await check(restoredUrl, restored);
    } finally { await restored.destroy(); }
    assert.ok(output.every(text => canaries.every(value => !text.includes(value))));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const terminal = once(child, "exit"); child.kill("SIGKILL"); await terminal; }
    server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await db?.destroy();
    try { for (const name of names) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
    finally { await admin.destroy(); await rm(folder, { recursive: true, force: true }); if (senderFolder) await rm(senderFolder, { recursive: true, force: true }); }
  }
});
