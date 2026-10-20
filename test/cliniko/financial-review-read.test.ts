import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settled } from "node:timers/promises";
import { ClinikoFinancialReviewReader } from "../../src/cliniko/financial-review-read.ts";
import type { ClinikoFinancialReviewConfig, ClinikoFinancialReviewPermission } from "../../src/cliniko/financial-review-read.ts";
import { encodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import type { ClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const apiKey = "synthetic-financial-au5", base = "https://api.au5.cliniko.com/v1";
const scope = { tenantId: "fixture-tenant", clinicId: "fixture-clinic", locationId: "fixture-location" };
const binding = { recallRef: "cliniko:recall:30", actionRef: uuid(1) };
const intent: ClinikoFinancialIntent = {
  actionRef: uuid(1), scope, patientId: "21", businessId: "11", credentialFingerprint: clinikoCredentialFingerprint(apiKey),
  booking: { kind: "book", actionRef: uuid(2), practitionerId: "12", appointmentTypeId: "13",
    startsAt: "2026-11-03T09:00:00.000Z", endsAt: "2026-11-03T09:30:00.000Z" },
  stripe: { accountRef: "acct_fixture", livemode: false },
  payment: { amount: 5000, currency: "gbp", policyVersion: "fees-1", termsVersion: "terms-1", deadline: "2026-11-02T08:00:00.000Z" },
  recipient: { kind: "email", address: "private-finance@example.invalid" },
  effects: { checkout: uuid(3), linkDelivery: uuid(4), receiptDelivery: uuid(5), checkoutExpiry: uuid(6), clinicalExpiry: uuid(7) },
  createdAt: "2026-11-01T09:00:00.000Z",
};
function notes(value: ClinikoFinancialIntent = intent): string {
  const result = encodeClinikoFinancialIntent(value); assert.ok(result.ok); return result.value;
}
function native(value: ClinikoFinancialIntent = intent) {
  return { id: "30", links: { self: `${base}/recalls/30` }, patient: { links: { self: `${base}/patients/21` } },
    recall_type: { links: { self: `${base}/recall_types/40` } }, notes: notes(value), recall_at: "2026-11-02",
    recalled: false, archived_at: null as string | null, created_at: "2026-11-01T09:00:00Z", updated_at: "2026-11-01T09:05:00Z",
    private_unknown: "private-chart-canary" };
}
const signal = () => new AbortController().signal;
function fixture(options: { response?: () => Response | Promise<Response>; permission?: ClinikoFinancialReviewPermission;
  budget?: ClinikoRequestBudget; config?: Partial<ClinikoFinancialReviewConfig> } = {}) {
  const events: string[] = [], calls: { url: string; init: RequestInit }[] = [], queries: unknown[] = [];
  const budget = options.budget ?? { claim: async () => { events.push("quota"); return null; }, observe429: async () => ({ kind: "rateLimited" as const }) };
  const config: ClinikoFinancialReviewConfig = { scope: { ...scope }, apiKey, contactEmail: "clinic@example.invalid", businessId: "11", recallTypeId: "40",
    stripe: { ...intent.stripe }, rateBudget: budget, clock: () => "2026-11-01T10:00:00.000Z", ...options.config };
  const permission: ClinikoFinancialReviewPermission = options.permission ?? { allows: async query => { events.push("permission"); queries.push(query); return true; } };
  const port: typeof fetch = async (url, init) => { events.push("GET"); calls.push({ url: String(url), init: init! }); return options.response ? options.response() : Response.json(native()); };
  const made = ClinikoFinancialReviewReader.create(config, permission, port); assert.ok(made.ok);
  return { reader: made.value, calls, events, queries, config };
}

test("financial review reads one exact private native record under current owner permission and the shared budget", async () => {
  for (const value of [intent, { ...intent, booking: { ...intent.booking, kind: "classBook" as const, sessionId: "14" } }]) {
    const f = fixture({ response: () => Response.json(native(value)) }), read = await f.reader.read(binding, signal());
    assert.ok(read.ok); assert.deepEqual(read.value.intent, value); assert.equal(read.value.kind, "context");
    assert.equal(read.value.recalled, false); assert.equal(read.value.archivedAt, null);
    assert.equal(read.value.observedAt, "2026-11-01T10:00:00.000Z");
    assert.deepEqual(f.events, ["permission", "quota", "permission", "GET", "permission"]);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.url, `${base}/recalls/30`);
    assert.equal(f.calls[0]!.init.method, "GET"); assert.equal(f.calls[0]!.init.redirect, "error");
    const headers = new Headers(f.calls[0]!.init.headers);
    assert.equal(headers.get("Authorization"), `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`);
    assert.equal(headers.get("User-Agent"), "Abby (clinic@example.invalid)");
    assert.ok(f.queries.every(query => Object.isFrozen(query)));
    assert.deepEqual(f.queries[0], { ...f.reader.selection(), ...binding });
    assert.equal(JSON.stringify(f.reader), "{}");
    assert.doesNotMatch(JSON.stringify(read), /private-chart-canary|synthetic-financial|Authorization|private_unknown/);
  }
});

test("recalled, archived and schema-valid edited financial notes remain context, never money or acknowledgement", async () => {
  for (const patch of [{ recalled: true }, { archived_at: "2026-11-01T09:06:00Z" },
    { notes: notes({ ...intent, payment: { ...intent.payment, amount: 6000 } }) }]) {
    const f = fixture({ response: () => Response.json({ ...native(), ...patch }) }), read = await f.reader.read(binding, signal());
    assert.ok(read.ok); assert.equal(read.value.kind, "context");
    for (const field of ["paid", "received", "bookingAcknowledged", "completed", "mayRetry", "payable"]) assert.equal(Object.hasOwn(read.value, field), false);
    assert.equal(f.calls.length, 1);
  }
});

test("financial reader refuses foreign scope, account, mode, action, native identity and patient/type/self links", async () => {
  const changes: Partial<ClinikoFinancialIntent>[] = [
    { actionRef: uuid(8) }, { scope: { ...scope, tenantId: "other" } }, { scope: { ...scope, clinicId: "other" } },
    { scope: { ...scope, locationId: "other" } }, { businessId: "15" }, { credentialFingerprint: "a".repeat(64) },
    { stripe: { ...intent.stripe, accountRef: "acct_other" } }, { stripe: { ...intent.stripe, livemode: true } }, { patientId: "22" },
  ];
  const rows = [
    ...changes.map(change => native({ ...intent, ...change })),
    { ...native(), id: "31" }, { ...native(), links: { self: `${base}/recalls/31` } },
    { ...native(), patient: { links: { self: `${base}/patients/22` } } },
    { ...native(), recall_type: { links: { self: `${base}/recall_types/41` } } },
    { ...native(), links: { self: "https://api.au5.cliniko.com.evil.invalid/v1/recalls/30" } },
  ];
  for (const row of rows) {
    const f = fixture({ response: () => Response.json(row) });
    assert.deepEqual(await f.reader.read(binding, signal()), { ok: false, error: { kind: "mismatched" } });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.init.method, "GET");
  }
});

test("financial native malformed envelopes, flags and timestamps cannot become private context", async () => {
  for (const patch of [{ notes: null }, { notes: "Abby appointment review v2" }, { recalled: null }, { recalled: "false" },
    { recall_at: "2026-11-31" }, { created_at: "2026-11-31T09:00:00Z" }, { updated_at: "2026-11-01T09:60:00Z" },
    { updated_at: "2026-11-01T08:00:00Z" }, { archived_at: "garbage" }, { archived_at: "2026-11-01T08:00:00Z" }]) {
    const f = fixture({ response: () => Response.json({ ...native(), ...patch }) });
    assert.deepEqual(await f.reader.read(binding, signal()), { ok: false, error: { kind: "malformed" } });
  }
});

test("initial financial permission denial or exception prevents even quota admission and native reads", async () => {
  for (const allows of [async () => false, async () => { throw new Error("private-role-canary"); }]) {
    const f = fixture({ permission: { allows } }), result = await f.reader.read(binding, signal());
    assert.equal(result.ok, false); assert.deepEqual(f.events, []); assert.equal(f.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-role-canary|private-finance|synthetic-financial/);
  }
});

test("financial permission revoked during quota admission prevents the protected GET", async () => {
  let allowed = true, claims = 0;
  const f = fixture({ permission: { allows: async () => allowed }, budget: {
    claim: async () => { claims++; allowed = false; return null; }, observe429: async () => ({ kind: "rateLimited" as const }),
  } });
  assert.deepEqual(await f.reader.read(binding, signal()), { ok: false, error: { kind: "forbidden" } });
  assert.equal(claims, 1); assert.equal(f.calls.length, 0);
});

test("financial permission revoked during native inspection discards all private context", async () => {
  let allowed = true;
  const f = fixture({ permission: { allows: async () => allowed }, response: () => { allowed = false; return Response.json(native()); } });
  const result = await f.reader.read(binding, signal());
  assert.deepEqual(result, { ok: false, error: { kind: "forbidden" } });
  assert.doesNotMatch(JSON.stringify(result), /private-finance|patient|5000|recall:30/);
});

test("quota denial and native HTTP failures never turn an absent financial record into retry authority", async () => {
  const denied = fixture({ budget: { claim: async () => ({ kind: "rateLimited", resetAt: "2026-11-01T10:01:00.000Z" }),
    observe429: async () => ({ kind: "rateLimited" as const }) } });
  assert.deepEqual(await denied.reader.read(binding, signal()), { ok: false, error: { kind: "rateLimited", resetAt: "2026-11-01T10:01:00.000Z" } });
  assert.equal(denied.calls.length, 0);
  for (const status of [301, 401, 403, 404, 422, 500]) {
    let cancelled = false;
    const f = fixture({ response: () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }) });
    const result = await f.reader.read(binding, signal());
    assert.deepEqual(result, { ok: false, error: { kind: status === 401 || status === 403 ? "forbidden" : "unavailable" } });
    assert.equal(f.calls.length, 1); assert.equal(cancelled, true);
    assert.doesNotMatch(JSON.stringify(result), /mayRetry|notFound|received|private-finance/);
  }
});

test("a native429 is observed by the same physical budget without another GET", async () => {
  let header: string | null | undefined;
  const f = fixture({ response: () => new Response(null, { status: 429, headers: { "X-RateLimit-Reset": "1793527260" } }),
    budget: { claim: async () => null, observe429: async value => { header = value; return { kind: "rateLimited", resetAt: "2026-11-01T10:01:00.000Z" }; } } });
  assert.deepEqual(await f.reader.read(binding, signal()), { ok: false, error: { kind: "rateLimited", resetAt: "2026-11-01T10:01:00.000Z" } });
  assert.equal(header, "1793527260"); assert.equal(f.calls.length, 1);
});

test("financial readers share the host's180-request account budget instead of creating their own headroom", async () => {
  const budget = new ClinikoReadBudget(180, () => 1_793_527_200_000);
  for (let i = 0; i < 178; i++) assert.equal(budget.claim(), null);
  const a = fixture({ budget }), b = fixture({ budget });
  assert.equal((await a.reader.read(binding, signal())).ok, true);
  assert.equal((await b.reader.read(binding, signal())).ok, true);
  const denied = await a.reader.read(binding, signal()); assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.kind, "rateLimited");
  assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 1);
});

test("an aborted or expired financial permission check cannot dispatch a late native read", async () => {
  for (const stage of ["permission", "budget"] as const) {
    const f = fixture({ config: { deadlineMs: 10 },
      ...(stage === "permission" ? { permission: { allows: async () => new Promise<boolean>(() => {}) } }
        : { budget: { claim: async () => new Promise<null>(() => {}), observe429: async () => ({ kind: "rateLimited" as const }) } }) });
    assert.deepEqual(await f.reader.read(binding, signal()), { ok: false, error: { kind: "unavailable" } });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(), controller = new AbortController(); controller.abort();
  assert.deepEqual(await f.reader.read(binding, controller.signal), { ok: false, error: { kind: "unavailable" } });
  assert.deepEqual(f.events, []);
});

test("late native headers after caller abort are retired without retaining their body", async () => {
  let deliver!: (value: Response) => void, cancelled = false;
  const f = fixture({ response: () => new Promise<Response>(resolve => { deliver = resolve; }) });
  const controller = new AbortController(), pending = f.reader.read(binding, controller.signal);
  await settled(); assert.equal(f.calls.length, 1); controller.abort();
  assert.deepEqual(await pending, { ok: false, error: { kind: "unavailable" } });
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  deliver(new Response(body)); await settled(); assert.equal(cancelled, true); assert.equal(body.locked, false);
});

test("stalled bodies and never-ending empty chunks respect financial abort and reader ownership", async () => {
  for (const empty of [false, true]) {
    let cancelled = false, reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; if (empty) controller.enqueue(new Uint8Array()); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); } });
    const f = fixture({ response: () => new Response(body), config: { deadlineMs: 100 } });
    assert.deepEqual(await f.reader.read(binding, signal()), { ok: false, error: { kind: "unavailable" } });
    assert.ok(reads > 0); assert.equal(cancelled, true); assert.equal(body.locked, false);
    assert.equal(f.calls.length, 1);
  }
});

test("oversized, invalidUTF8, invalidJSON and locked native financial bodies disclose no context", async () => {
  for (const bytes of [new Uint8Array(1_000_001), new Uint8Array([255]), new TextEncoder().encode("{broken")]) {
    const f = fixture({ response: () => new Response(bytes) });
    assert.deepEqual(await f.reader.read(binding, signal()), { ok: false, error: { kind: "malformed" } });
  }
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(native()))); } });
  const response = new Response(body), otherOwner = body.getReader(), f = fixture({ response: () => response });
  assert.deepEqual(await f.reader.read(binding, signal()), { ok: false, error: { kind: "unavailable" } });
  assert.equal(body.locked, true); await otherOwner.cancel(); otherOwner.releaseLock();
});

test("copied body bytes cannot be changed by a producer reusing its earlier chunk", async () => {
  const raw = new TextEncoder().encode(JSON.stringify(native())), replacement = new TextEncoder().encode(JSON.stringify(native({ ...intent, payment: { ...intent.payment, amount: 9000 } })));
  assert.equal(raw.length, replacement.length); let reads = 0, retired = false;
  const f = fixture({ response: () => ({ status: 200, headers: new Headers(), body: { getReader: () => ({
    async read() { if (reads++ === 0) return { done: false, value: raw }; raw.set(replacement); return { done: true }; },
    async cancel() {}, releaseLock() { retired = true; },
  }) } }) as unknown as Response });
  const read = await f.reader.read(binding, signal()); assert.ok(read.ok); assert.equal(read.value.intent.payment.amount, 5000); assert.equal(retired, true);
});

test("a synchronously throwing body cancel cannot retain the financial reader lock or leak upstream errors", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(native())); let reads = 0, released = false;
  const f = fixture({ response: () => ({ status: 200, headers: new Headers(), body: { getReader: () => ({
    async read() { return reads++ === 0 ? { done: false, value: bytes } : { done: true }; },
    cancel() { throw new Error("private-cancel-canary"); }, releaseLock() { released = true; },
  }) } }) as unknown as Response });
  const result = await f.reader.read(binding, signal()); assert.ok(result.ok); assert.equal(released, true);
  assert.doesNotMatch(JSON.stringify(result), /private-cancel-canary/);
});

test("a rejected native response with broken cancellation still returns only a bounded financial failure", async () => {
  const f = fixture({ response: () => ({ status: 500, body: { cancel() { throw new Error("private-rejected-body-canary"); } } }) as unknown as Response });
  assert.deepEqual(await f.reader.read(binding, signal()), { ok: false, error: { kind: "unavailable" } });
  assert.equal(f.calls.length, 1);
});

test("factory and exact query validation require explicit native budget and never expose credentials", async () => {
  const f = fixture(), permission = { allows: async () => true };
  for (const patch of [{ apiKey: "bad" }, { apiKey: "private\nkey-au5" }, { recallTypeId: "0" }, { businessId: "" },
    { scope: { ...scope, locationId: "" } }, { stripe: { ...intent.stripe, livemode: "false" } },
    { rateBudget: undefined }, { clock: 1 }, { deadlineMs: 0 }, { deadlineMs: 15_001 }]) {
    assert.deepEqual(ClinikoFinancialReviewReader.create({ ...f.config, ...patch } as unknown as ClinikoFinancialReviewConfig, permission),
      { ok: false, error: { kind: "invalidConfig" } });
  }
  for (const query of [{ ...binding, recallRef: "https://evil.invalid/30" }, { ...binding, recallRef: "cliniko:recall:0" }, { ...binding, actionRef: "private-patient-id" }])
    assert.deepEqual(await f.reader.read(query, signal()), { ok: false, error: { kind: "invalidQuery" } });
  assert.equal(f.calls.length, 0); assert.equal(JSON.stringify(f.reader), "{}");
  assert.ok(Object.isFrozen(f.reader.selection().scope)); assert.ok(Object.isFrozen(f.reader.selection().stripe));
});

test("mutable caller bindings and configuration cannot redirect an in-flight financial read", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; }); let checks = 0;
  const f = fixture({ permission: { allows: async () => { if (++checks === 1) await gate; return true; } } });
  const wanted = { ...binding }, read = f.reader.read(wanted, signal());
  wanted.recallRef = "cliniko:recall:99"; wanted.actionRef = uuid(9);
  Object.assign(f.config.scope, { locationId: "other" }); Object.assign(f.config.stripe, { accountRef: "acct_other" });
  release(); const result = await read; assert.ok(result.ok); assert.equal(f.calls[0]!.url, `${base}/recalls/30`);
  assert.equal(result.value.intent.scope.locationId, scope.locationId); assert.equal(result.value.intent.stripe.accountRef, intent.stripe.accountRef);
});

test("financial selection projects approved ownership fields instead of copying extra private configuration", async () => {
  const f = fixture({ config: { scope: Object.assign({ ...scope }, { privateDraft: "private-draft-canary" }),
    stripe: Object.assign({ ...intent.stripe }, { apiKey: "private-stripe-key-canary" }) } });
  const result = await f.reader.read(binding, signal()); assert.ok(result.ok);
  assert.doesNotMatch(JSON.stringify(f.reader.selection()), /private-draft-canary|private-stripe-key-canary|apiKey|privateDraft/);
  assert.doesNotMatch(JSON.stringify(f.queries), /private-draft-canary|private-stripe-key-canary|apiKey|privateDraft/);
});
