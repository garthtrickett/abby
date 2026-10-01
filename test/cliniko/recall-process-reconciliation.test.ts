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

type StoredRecall = { id: string; patientId: string; notes: string };
const summary = "Synthetic private follow-up request for a patient";
const apiKey = "synthetic-recall-process-key-au5";
const base = "https://api.au5.cliniko.com/v1";

test("E2E-206 C1 process/database journey observes a committed lost response without replay",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const databaseName = `abby_recall_process_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  const tenantId = `recall-${randomUUID()}`;
  const cases = [
    { patientId: "918273645546372", marker: randomUUID(), commit: true, observed: "one" },
    { patientId: "918273645546373", marker: randomUUID(), commit: false, observed: "none" },
  ] as const;
  const rows: StoredRecall[] = [];
  let writes = 0;
  let commitNext = false;
  let serverFailure: unknown;
  const server = createServer((request, response) => {
    void (async () => {
      const route = new URL(request.url ?? "", "http://127.0.0.1");
      assert.equal(route.pathname, "/v1/recalls");
      assert.equal(request.headers.authorization, `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`);
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const expected = cases[writes];
        assert.ok(expected);
        assert.deepEqual(body, { patient_id: expected.patientId, recall_type_id: "7",
          recall_at: "2026-10-01", notes: `Abby request ${expected.marker}\n${summary}`, recalled: false });
        writes += 1;
        if (commitNext) rows.push({ id: "91", patientId: expected.patientId, notes: String(body.notes) });
        response.destroy();
        return;
      }
      assert.equal(request.method, "GET");
      assert.equal(route.searchParams.get("page"), "1");
      assert.equal(route.searchParams.get("per_page"), "100");
      assert.equal(route.searchParams.get("sort"), "id:asc");
      const filter = route.searchParams.getAll("q[]");
      assert.equal(filter.length, 1);
      const patientId = filter[0]?.match(/^patient_id:=([1-9][0-9]*)$/)?.[1];
      assert.ok(patientId);
      const recalls = rows.filter(row => row.patientId === patientId).map(row => ({ id: row.id,
        notes: row.notes, recalled: false, archived_at: null, recall_at: "2026-10-01",
        patient: { links: { self: `${base}/patients/${row.patientId}` } },
        recall_type: { links: { self: `${base}/recall_types/7` } } }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ total_entries: recalls.length, recalls }));
    })().catch(error => { serverFailure = error; response.writeHead(500).end(); });
  });
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  const output: string[] = [];
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const proxy = `http://127.0.0.1:${address.port}`;
    const run = async (mode: "attempt" | "observe", item: (typeof cases)[number]): Promise<string> => {
      const child = spawn(process.execPath, ["test/support/cliniko-recall-process-worker.ts", mode], {
        cwd: new URL("../../", import.meta.url),
        env: { DATABASE_URL: target.toString(), ABBY_TEST_RECALL_PROXY: proxy,
          ABBY_TEST_RECALL_TENANT: tenantId, ABBY_TEST_RECALL_PATIENT: item.patientId,
          ABBY_TEST_RECALL_MARKER: item.marker, ABBY_TEST_RECALL_SUMMARY: summary },
        stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(20_000),
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
      const [code] = await once(child, "exit");
      const written = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      output.push(written, errors);
      assert.equal(code, 0, errors);
      return written.trim();
    };
    for (const item of cases) {
      commitNext = item.commit;
      assert.equal(await run("attempt", item), "uncertain");
      assert.equal(await run("observe", item), item.observed);
      assert.equal(writes, item.commit ? 1 : 2, "an observation must never send another POST");
    }
    assert.equal(serverFailure, undefined);
    assert.equal(rows.length, 1);
    const canaries = [
      ...cases.flatMap((item, index) => [
        { label: `patient_${index}`, value: item.patientId },
        { label: `marker_${index}`, value: item.marker },
      ]),
      { label: "summary", value: summary },
    ];
    assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
    for (const canary of canaries) assert.ok(output.every(part => !part.includes(canary.value)));
  } finally {
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
