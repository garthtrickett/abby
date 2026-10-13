import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import type { ClinikoReviewRequest } from "../../src/cliniko/review-request.ts";

const base = "https://api.au5.cliniko.com/v1";

test("E2E-267 killed senders lose all context; replacement owners discover only provider-owned work without replay",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const databaseName = `abby_review_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
  const scope = { tenantId: `review-${randomUUID()}`, clinicId: "clinic" };
  const request: ClinikoReviewRequest & { operation: Extract<ClinikoReviewRequest["operation"], { kind: "book" }> } = { scope: { ...scope, locationId: "review-location" }, patientId: "918273645546372",
    businessId: "11", credentialFingerprint: "a".repeat(64), policyVersion: "private-review-policy-canary",
    termsVersion: "private-review-terms-canary", timeZone: "Asia/Jakarta", createdAt: "2026-10-04T04:00:00Z",
    operation: { kind: "book", practitionerId: "22", appointmentTypeId: "33",
      startsAt: "2026-10-08T04:00:00Z", endsAt: "2026-10-08T04:30:00Z" } };
  let rows: Array<Record<string, unknown>> = [];
  let shouldCommit = false, posts = 0;
  let posted: () => void = () => undefined;
  let serverFailure: unknown;
  const output: string[] = [], children: ReturnType<typeof spawn>[] = [];
  const server = createServer((incoming, response) => {
    void (async () => {
      const route = new URL(incoming.url ?? "", "http://127.0.0.1");
      assert.equal(route.pathname, "/v1/recalls", "recovery cannot send an appointment mutation");
      if (incoming.method === "POST") {
        posts += 1;
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (shouldCommit) rows.push({ id: "91", notes: body.notes, recalled: false, archived_at: null,
          recall_at: body.recall_at, patient: { links: { self: `${base}/patients/${body.patient_id}` } },
          recall_type: { links: { self: `${base}/recall_types/${body.recall_type_id}` } } });
        posted(); // Hold the response until the sender is SIGKILLed during provider processing.
        return;
      }
      assert.equal(incoming.method, "GET");
      assert.equal(route.searchParams.has("q[]"), false, "discovery is not fed the lost patient or marker");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ total_entries: rows.length, recalls: rows }));
    })().catch(error => { serverFailure = error; response.writeHead(500).end(); });
  });
  let db: ReturnType<typeof connectPostgres> | undefined, created = false;
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const proxy = `http://127.0.0.1:${address.port}`;
    const launch = (mode: "attempt" | "discover", input: Record<string, unknown>) => {
      const child = spawn(process.execPath, ["test/support/cliniko-review-discovery-worker.ts", mode], {
        cwd: new URL("../../", import.meta.url), env: { DATABASE_URL: target.toString() },
        stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(15_000),
      });
      children.push(child);
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      const exited = once(child, "exit").then(([code, signal]) => {
        output.push(stdout, stderr); return { code, signal, stdout, stderr };
      });
      child.stdin.end(JSON.stringify(input)); return { child, exited };
    };
    const markers: string[] = [];
    for (const commit of [true, false]) {
      rows = []; shouldCommit = commit;
      const marker = randomUUID(); markers.push(marker);
      const started = new Promise<void>(resolve => { posted = resolve; });
      const sender = launch("attempt", { scope, proxy, marker, request });
      await Promise.race([started, sender.exited.then(result => { throw new Error(`sender exited before send: ${result.code}`); })]);
      assert.equal(sender.child.kill("SIGKILL"), true);
      const killed = await sender.exited; assert.equal(killed.signal, "SIGKILL");
      const recovery = launch("discover", { scope, proxy, recallTypeId: "7" });
      const recovered = await recovery.exited; assert.equal(recovered.code, 0, recovered.stderr);
      assert.deepEqual(JSON.parse(recovered.stdout), { pending: commit ? 1 : 0, invalid: 0, ambiguous: 0,
        book: commit ? 1 : 0, cancel: 0, reschedule: 0 });
      assert.equal(posts, commit ? 1 : 2, "fresh recovery did not replay the uncertain POST");
    }
    assert.equal(serverFailure, undefined);
    const canaries = [request.patientId, request.policyVersion, request.termsVersion, request.operation.startsAt,
      ...markers].map((value, index) => ({ label: `review_${index}`, value }));
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
