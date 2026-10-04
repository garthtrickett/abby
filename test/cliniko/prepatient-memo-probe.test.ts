import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ClinikoPrepatientMemoProbe } from "../../phase-0/probes/cliniko_prepatient_memo.ts";

const config = { apiKey: "synthetic-prepatient-secret-au5", contactEmail: "owner@example.test" };
const base = "https://api.au5.cliniko.com/v1";
type Row = Record<string, unknown>;
function provider(accept = false) {
  const rows: Row[] = [], requests: { method: string; path: string; body: Row | undefined }[] = [];
  let fault: ((method: string, url: URL, body: Row | undefined) => Response | undefined) | undefined;
  let loseCreate = false;
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET", path = url.pathname.slice(3);
    const body = init?.body ? JSON.parse(String(init.body)) as Row : undefined;
    requests.push({ method, path, body });
    assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    assert.ok(path.startsWith("/communications"), "no patient or appointment endpoint exists");
    const failure = fault?.(method, url, body); if (failure) return failure;
    const [, , rowId, action] = path.split("/");
    if (method === "POST" && !rowId) {
      assert.ok(body); assert.ok(body.patient_id === undefined || body.patient_id === null);
      assert.equal(body.type_code, 4); assert.equal(body.category_code, 12);
      if (!accept) return Response.json({ errors: { patient: ["must exist", "private provider canary"] } }, { status: 422 });
      const row = { ...body, id: "91", patient: null, archived_at: null, updated_at: "2026-10-04T12:00:00Z" };
      rows.push(row);
      if (loseCreate) throw new Error("secret provider detail after commit");
      return Response.json(row, { status: 201 });
    }
    if (method === "POST") {
      assert.equal(action, "archive");
      const row = rows.find(item => item.id === rowId); assert.ok(row);
      row.archived_at = "2026-10-04T12:01:00Z";
      return new Response(null, { status: 204 });
    }
    assert.equal(method, "GET");
    if (rowId) return Response.json(rows.find(row => row.id === rowId));
    assert.equal(url.searchParams.get("sort"), "id:asc");
    assert.deepEqual(url.searchParams.getAll("q[]"), ["category_code:=12"]);
    const active = rows.filter(row => row.archived_at === null);
    const page = Number(url.searchParams.get("page"));
    return Response.json({ communications: active.slice((page - 1) * 100, page * 100), total_entries: active.length });
  };
  return { rows, requests, fetchPort, setFault(value: typeof fault) { fault = value; }, loseResponse() { loseCreate = true; } };
}
const probe = (fake: ReturnType<typeof provider>) => new ClinikoPrepatientMemoProbe(config, fake.fetchPort);

test("E2E-291 omitted and null patient memos report only the rejected field and make no patient or appointment write", async () => {
  for (const mode of ["omit", "null"] as const) {
    const fake = provider(), result = await probe(fake).run(mode);
    assert.deepEqual(result, { ok: true, value: { kind: "rejected", rejectedPatientField: true,
      activeProbeMemos: 0, patientlessProbeMemos: 0, patientOrAppointmentWrites: 0 } });
    assert.equal(fake.requests.filter(row => row.method === "POST").length, 1);
    for (const privateValue of [config.apiKey, config.contactEmail, "private provider canary", "must exist"]) {
      assert.ok(!JSON.stringify(result).includes(privateValue));
    }
  }
});

test("E2E-291 an accepted synthetic memo is independently discovered by a fresh owner and guarded cleanup archives only that memo", async () => {
  const fake = provider(true);
  const accepted = await probe(fake).run("omit"); assert.ok(accepted.ok);
  assert.equal(accepted.value.kind, "memoAccepted"); assert.equal(accepted.value.patientlessProbeMemos, 1);
  const fresh = await probe(fake).run("status"); assert.ok(fresh.ok); assert.equal(fresh.value.activeProbeMemos, 1);
  assert.equal((await probe(fake).run("null")).ok, true);
  assert.equal(fake.requests.filter(row => row.method === "POST" && row.path === "/communications").length, 1);
  const cleaned = await probe(fake).run("cleanup"); assert.ok(cleaned.ok);
  assert.equal(cleaned.value.kind, "cleaned"); assert.equal(cleaned.value.activeProbeMemos, 0);
  assert.deepEqual(fake.requests.filter(row => row.method === "POST").map(row => row.path),
    ["/communications", "/communications/91/archive"]);
  assert.ok(!JSON.stringify([accepted, fresh, cleaned]).includes(String(fake.rows[0]?.content)));
});

test("E2E-291 possible-create response loss stops without retry; a replacement discovers the memo with no original marker", async () => {
  const fake = provider(true); fake.loseResponse();
  assert.deepEqual(await probe(fake).run("omit"), { ok: false, error: { kind: "uncertainCreate" } });
  const fresh = await probe(fake).run("status"); assert.ok(fresh.ok); assert.equal(fresh.value.activeProbeMemos, 1);
  await probe(fake).run("omit");
  assert.equal(fake.requests.filter(row => row.method === "POST" && row.path === "/communications").length, 1);
  assert.ok((await probe(fake).run("cleanup")).ok);
});

test("E2E-291 foreign records survive cleanup and bounded full pagination cannot be described as empty after a malformed or partial scan", async () => {
  const fake = provider();
  for (let index = 1; index <= 105; index++) fake.rows.push({ id: String(index), category_code: 12,
    archived_at: null, from: "another source", content: "foreign patient content" });
  const found = await probe(fake).run("status"); assert.ok(found.ok); assert.equal(found.value.activeProbeMemos, 0);
  assert.equal(fake.requests.filter(row => row.method === "GET").length, 2);
  assert.ok((await probe(fake).run("cleanup")).ok); assert.equal(fake.requests.some(row => row.method === "POST"), false);
  for (const payload of [
    { communications: [], total_entries: 501 }, { communications: [], total_entries: 1 },
    { communications: [{ id: "1", archived_at: null, category_code: 99 }], total_entries: 1 },
    { communications: [{ id: "1", archived_at: "2026-10-04T12:00:00Z", category_code: 12 }], total_entries: 1 },
    { communications: [{ id: "2", archived_at: null, category_code: 12 }, { id: "1", archived_at: null, category_code: 12 }], total_entries: 2 },
  ]) {
    const broken = provider(); broken.setFault(() => Response.json(payload));
    assert.deepEqual(await probe(broken).run("omit"), { ok: false, error: { kind: "unavailable" } });
    assert.equal(broken.requests.some(row => row.method === "POST"), false);
  }
});

test("E2E-291 edited tagged records and changed cleanup snapshots are never archived", async () => {
  const fake = provider(true); assert.ok((await probe(fake).run("omit")).ok);
  fake.rows[0]!.content = "edited private patient content";
  assert.deepEqual(await probe(fake).run("cleanup"), { ok: false, error: { kind: "unsafeCleanup" } });
  const changed = provider(true); assert.ok((await probe(changed).run("omit")).ok);
  changed.setFault((method, url) => method === "GET" && url.pathname === "/v1/communications/91"
    ? Response.json({ ...changed.rows[0], updated_at: "2026-10-04T12:01:00Z" }) : undefined);
  assert.deepEqual(await probe(changed).run("cleanup"), { ok: false, error: { kind: "unsafeCleanup" } });
  for (const item of [fake, changed]) assert.equal(item.requests.some(row => row.path.endsWith("/archive")), false);
});

test("E2E-291 create rejection without a patient-field error is not described as proven patient requirement", async () => {
  const fake = provider(); fake.setFault(method => method === "POST"
    ? Response.json({ errors: { content: ["unrelated rejection"] } }, { status: 422 }) : undefined);
  const result = await probe(fake).run("omit"); assert.ok(result.ok);
  assert.equal(result.value.rejectedPatientField, false);
});

test("E2E-291 unavailable and mismatched create acknowledgments stop research without replay or cleanup guesses", async () => {
  for (const failure of [new Response("secret transport body", { status: 503 }),
    Response.json({ id: "91", category_code: 12, content: "wrong acknowledgment" }, { status: 201 })]) {
    const fake = provider(); fake.setFault(method => method === "POST" ? failure : undefined);
    assert.deepEqual(await probe(fake).run("omit"), { ok: false, error: { kind: "uncertainCreate" } });
    assert.equal(fake.requests.filter(row => row.method === "POST").length, 1);
  }
});

test("E2E-291 owner command refuses live access without opt-in and never echoes credentials", () => {
  const executed = spawnSync(process.execPath, ["scripts/probe-cliniko-prepatient-memo.ts", "omit"], {
    cwd: new URL("../../", import.meta.url), env: { ...process.env, ABBY_LIVE_CLINIKO_EVAL: "0",
      ABBY_CLINIKO_API_KEY: config.apiKey, ABBY_CLINIKO_CONTACT_EMAIL: config.contactEmail }, encoding: "utf8" });
  assert.equal(executed.status, 1);
  assert.match(executed.stderr, /probe unavailable/);
  assert.ok(!executed.stdout.includes(config.apiKey)); assert.ok(!executed.stderr.includes(config.apiKey));
});

test("E2E-291 noncooperative reads and possible sends have bounded outcomes without a later dispatch or replay", async () => {
  const held = new ClinikoPrepatientMemoProbe({ ...config, timeoutMs: 10 }, async () => new Promise<Response>(() => {}));
  assert.deepEqual(await held.run("omit"), { ok: false, error: { kind: "unavailable" } });
  const fake = provider(); let posts = 0;
  const stopped = new ClinikoPrepatientMemoProbe({ ...config, timeoutMs: 10 }, async (input, init) => {
    if (init?.method === "POST") { posts++; return new Promise<Response>(() => {}); }
    return fake.fetchPort(input, init);
  });
  assert.deepEqual(await stopped.run("omit"), { ok: false, error: { kind: "uncertainCreate" } });
  assert.equal(posts, 1);
  const stream = new ClinikoPrepatientMemoProbe({ ...config, timeoutMs: 10 }, async () =>
    new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }));
  assert.deepEqual(await stream.run("status"), { ok: false, error: { kind: "unavailable" } });
});
