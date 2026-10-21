import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { err, ok } from "../../src/core/model.ts";
import { AdministrativeMemoAuthentication, encodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { ClinikoAdministrativeMemos, administrativeMemoRecordBinding } from "../../src/cliniko/administrative-memo-records.ts";
import type { AdministrativeMemoConfig, AdministrativeMemoQuery } from "../../src/cliniko/administrative-memo-records.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { administrativeMemoInput } from "../support/administrative-memo.ts";
import { value } from "../support/outbound-records.ts";

function fixture(deadlineMs = 500) {
  const input = administrativeMemoInput(), auth = new AdministrativeMemoAuthentication(randomBytes(32)), memo = value(auth.sign(input));
  const state = { current: true, allowed: true, producer: true, now: input.recordedAt,
    beforeClaim: undefined as undefined | (() => void), beforeBudget: undefined as undefined | (() => void),
    beforePermission: undefined as undefined | (() => Promise<void>),
    response: undefined as undefined | ((row: Record<string, unknown>) => Response), mode: "ack" as "ack" | "lostStored" | "lostUnstored" };
  const actual = new ClinikoReadBudget(180, () => Date.parse(state.now)), claims = { native: 0, effects: 0, limited: 0 };
  const budget = { claim: async () => { claims.native++; state.beforeBudget?.(); return actual.claim(); }, observe429: async (header: string | null) => { claims.limited++; return actual.observe429(header); } };
  const config: AdministrativeMemoConfig = { scope: { ...input.scope }, businessId: input.businessId, apiKey: "synthetic-memo-au5", contactEmail: "ops@example.invalid",
    authorRef: input.authorRef, policy: { ...input.policy }, rateBudget: budget, clock: () => state.now, deadlineMs };
  const permissions: AdministrativeMemoQuery[] = [], authority = { allows: async (q: AdministrativeMemoQuery) => {
    permissions.push(q); await state.beforePermission?.(); return state.allowed;
  }, current: () => state.current, producerAdmitted: async () => state.producer };
  const consumed = new Map<string, string>(), selectedScope = structuredClone(input.scope);
  const barrierFor = (c = config, a = auth) => {
    const owner = administrativeMemoRecordBinding(c, a)!;
    return { matches: (scope: typeof input.scope, binding: string) => JSON.stringify(scope) === JSON.stringify(selectedScope) && binding === owner,
      claimOnce: async (ref: string) => { claims.effects++; state.beforeClaim?.();
        if (consumed.has(ref)) return consumed.get(ref) === owner ? ok({ claimed: false }) : err({ kind: "bindingMismatch" as const });
        consumed.set(ref, owner); return ok({ claimed: true }); } };
  };
  const rows = new Map<string, Record<string, unknown>>(), requests: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  const port: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, "error"); assert.equal(new Headers(init!.headers).get("authorization"), `Basic ${Buffer.from("synthetic-memo-au5:").toString("base64")}`);
    assert.equal(new Headers(init!.headers).get("user-agent"), "Abby (ops@example.invalid)");
    const u = new URL(String(url)); assert.equal(u.origin, "https://api.au5.cliniko.com");
    if (init!.method === "POST") {
      assert.equal(u.pathname, "/v1/communications"); const body = JSON.parse(String(init!.body)); requests.push({ url: u.href, method: "POST", body });
      assert.deepEqual(Object.keys(body).sort(), ["category_code", "confidential", "content", "direction_code", "patient_id", "type_code"]);
      const row = { ...body, id: "701", created_at: state.now, updated_at: state.now, archived_at: null,
        category: "Memo", type: "Email", direction_description: "Sent", // Numeric request/receipt codes are authoritative, not illustrative labels.
        links: { self: "https://api.au5.cliniko.com/v1/communications/701" }, patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${body.patient_id}` } } };
      if (state.mode !== "lostUnstored") rows.set("701", structuredClone(row));
      if (state.mode !== "ack") throw Error("Synthetic native response lost");
      return state.response?.(row) ?? Response.json(row, { status: 201 });
    }
    assert.equal(init!.method, "GET"); assert.equal(u.searchParams.get("q[]"), "archived_at:*");
    requests.push({ url: u.href, method: "GET" }); const row = rows.get(u.pathname.split("/").at(-1)!);
    return row ? Response.json(row) : new Response(null, { status: 404 });
  };
  const client = value(ClinikoAdministrativeMemos.create(config, auth, authority, barrierFor(), port));
  const binding = { communicationRef: "cliniko:communication:701", actionRef: memo.actionRef, patientId: memo.patientId };
  return { input, memo, auth, config, state, claims, authority, permissions, consumed, rows, requests, port, client, binding, barrierFor, actual };
}
const signal = () => new AbortController().signal;

test("create confidential memo through exact documented native fields, and read only under independent decoded grants", async () => {
  const f = fixture(); assert.deepEqual(value(await f.client.retainOnce(f.memo, signal())), { kind: "accepted", communicationRef: f.binding.communicationRef, actionRef: f.memo.actionRef });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.body!.direction_code, 2);
  const found = value(await f.client.readMemo(f.binding, signal())); assert.deepEqual(found.memo, f.memo);
  assert.equal(f.permissions.filter(q => q.operation === "readAdministrativeMemo").length, 2);
  assert.ok(f.permissions.some(q => q.operation === "readAdministrativeMemo" && q.includeArchived && q.memoDigest));
  assert.equal(f.claims.native, 2); assert.equal(f.claims.effects, 1);
});

test("outbound call direction uses the protected original direction, not request labels or a guessed recipient", async () => {
  const f = fixture(), memo = value(f.auth.sign({ ...f.input, direction: "outbound" }));
  assert.equal(value(await f.client.retainOnce(memo, signal())).kind, "accepted"); assert.equal(f.requests[0]!.body!.direction_code, 1);
});

for (const denied of ["permission", "current", "producer"] as const)
test(`MAC possession and patient ID cannot bypass independent ${denied} before the native effect`, async () => {
  const f = fixture(); if (denied === "permission") f.state.allowed = false; if (denied === "current") f.state.current = false; if (denied === "producer") f.state.producer = false;
  assert.equal((await f.client.retainOnce(f.memo, signal())).ok, false); assert.equal(f.requests.length, 0); assert.equal(f.claims.effects, 0);
});

for (const field of ["patientId", "scope", "businessId", "authorRef", "policy", "credentialFingerprint"] as const)
test(`signed foreign ${field} refuses before consuming a native purpose`, async () => {
  const f = fixture(), patch: any = { patientId: "322", scope: { ...f.input.scope, clinicId: "other" }, businessId: "2", authorRef: "other",
    policy: { version: "other", digest: "b".repeat(64) }, credentialFingerprint: "b".repeat(64) };
  const memo = value(f.auth.sign({ ...f.input, [field]: patch[field] }));
  if (field === "patientId") { // The native adapter cannot invent subject authority: the clinic producer grant must refuse this actual query.
    f.authority.producerAdmitted = async () => false;
    const client = value(ClinikoAdministrativeMemos.create(f.config, f.auth, f.authority, f.barrierFor(), f.port));
    assert.equal((await client.retainOnce(memo, signal())).ok, false);
  } else assert.equal((await f.client.retainOnce(memo, signal())).ok, false);
  assert.equal(f.requests.length, 0); assert.equal(f.claims.effects, 0);
});

test("parallel native retention uses one global opaque purpose and cannot repeat the POST", async () => {
  const f = fixture(), results = await Promise.all([f.client.retainOnce(f.memo, signal()), f.client.retainOnce(f.memo, signal())]);
  assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1);
  assert.equal(results.filter(r => !r.ok && r.error.kind === "alreadyClaimed").length, 1);
  assert.equal(f.requests.length, 1); assert.equal(f.consumed.size, 1);
});

for (const mode of ["lostStored", "lostUnstored"] as const)
test(`${mode} native acknowledgement stays consumed, and only an independently read exact memo establishes retention`, async () => {
  const f = fixture(); f.state.mode = mode;
  assert.deepEqual(value(await f.client.retainOnce(f.memo, signal())), { kind: "uncertain" });
  assert.equal((await f.client.retainOnce(f.memo, signal())).ok, false); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
  const read = value(ClinikoAdministrativeMemos.createReadOnly(f.config, f.auth, f.authority, f.port));
  assert.equal((await read.readMemo(f.binding, signal())).ok, mode === "lostStored");
});

test("a changed signing key or policy cannot create a fresh purpose after an uncertain write", async () => {
  const f = fixture(); f.state.mode = "lostUnstored"; assert.equal(value(await f.client.retainOnce(f.memo, signal())).kind, "uncertain");
  const auth = new AdministrativeMemoAuthentication(randomBytes(32)), policy = { version: "v2", digest: "b".repeat(64) }, config = { ...f.config, policy };
  const memo = value(auth.sign({ ...f.input, policy })), changed = value(ClinikoAdministrativeMemos.create(config, auth, f.authority, f.barrierFor(config, auth), f.port));
  assert.equal(memo.actionRef, f.memo.actionRef); assert.equal((await changed.retainOnce(memo, signal())).ok, false);
  assert.equal(f.requests.length, 1);
});

for (const waitAt of ["claim", "budget"] as const)
test(`authority withdrawn during ${waitAt} wait prevents dispatch while retaining the claimed exclusion`, async () => {
  const f = fixture(); if (waitAt === "claim") f.state.beforeClaim = () => { f.state.current = false; }; else f.state.beforeBudget = () => { f.state.current = false; };
  assert.equal((await f.client.retainOnce(f.memo, signal())).ok, false); assert.equal(f.requests.length, 0); assert.equal(f.consumed.size, 1);
});

test("real physical native180 denial consumes no POST and cannot be bypassed by another invocation", async () => {
  const f = fixture(); for (let n = 0; n < 180; n++) assert.equal(f.actual.claim(), null);
  assert.equal((await f.client.retainOnce(f.memo, signal())).ok, false); assert.equal(f.requests.length, 0); assert.equal(f.consumed.size, 1);
  assert.equal((await f.client.retainOnce(f.memo, signal())).ok, false); assert.equal(f.requests.length, 0);
});

for (const field of ["content", "confidential", "patient", "category_code", "type_code", "direction_code", "links", "archived_at", "created_at"] as const)
test(`nonexact native201 ${field} remains uncertain and cannot replay`, async () => {
  const f = fixture(); f.state.response = row => Response.json({ ...row, [field]: { content: "changed staff text", confidential: false,
    patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/322" } }, category_code: 1, type_code: 2, direction_code: 1,
    links: { self: "https://foreign.invalid/communications/701" }, archived_at: f.state.now, created_at: "2026-02-30T00:00:00Z" }[field] }, { status: 201 });
  assert.equal(value(await f.client.retainOnce(f.memo, signal())).kind, "uncertain"); assert.equal((await f.client.retainOnce(f.memo, signal())).ok, false);
  assert.equal(f.requests.length, 1);
});

test("body completion can establish a known exact ACK while later disclosure is withheld", async () => {
  const f = fixture(); f.state.response = row => new Response(new ReadableStream({ pull(controller) {
    f.state.current = false; controller.enqueue(new TextEncoder().encode(JSON.stringify(row))); controller.close();
  } }, { highWaterMark: 0 }), { status: 201 });
  assert.deepEqual(value(await f.client.retainOnce(f.memo, signal())), { kind: "acceptedWithheld" });
  f.state.current = true; assert.equal((await f.client.readMemo(f.binding, signal())).ok, true); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});

test("native201 headers without a complete bounded body establish no receipt", async () => {
  const f = fixture(20); f.state.response = () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { status: 201 });
  assert.deepEqual(value(await f.client.retainOnce(f.memo, signal())), { kind: "uncertain" }); assert.equal(f.requests.length, 1);
});

test("a held permission cannot send after the whole operation deadline", async () => {
  const f = fixture(20); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); f.state.beforePermission = () => held;
  assert.equal((await f.client.retainOnce(f.memo, signal())).ok, false); release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 0); assert.equal(f.consumed.size, 0);
});

test("archived signed records remain readable; edited content or decoded permission withdrawal cannot establish a result", async () => {
  const f = fixture(); value(await f.client.retainOnce(f.memo, signal())); f.rows.get("701")!.archived_at = f.state.now;
  assert.equal(value(await f.client.readMemo(f.binding, signal())).archivedAt, f.state.now);
  f.rows.get("701")!.content = value(encodeAdministrativeMemo(value(f.auth.sign({ ...f.input, patientId: "322" }))));
  assert.equal((await f.client.readMemo(f.binding, signal())).ok, false);
  f.rows.get("701")!.content = value(encodeAdministrativeMemo(f.memo));
  f.authority.allows = async q => !q.memo;
  const fresh = value(ClinikoAdministrativeMemos.createReadOnly(f.config, f.auth, f.authority, f.port));
  assert.equal((await fresh.readMemo(f.binding, signal())).ok, false);
});

test("equivalent scope/policy key ordering has the same owner binding", () => {
  const f = fixture(); assert.equal(administrativeMemoRecordBinding(f.config, f.auth), administrativeMemoRecordBinding({ ...f.config,
    scope: { locationId: f.config.scope.locationId, clinicId: f.config.scope.clinicId, tenantId: f.config.scope.tenantId },
    policy: { digest: f.config.policy.digest, version: f.config.policy.version } }, f.auth));
});
