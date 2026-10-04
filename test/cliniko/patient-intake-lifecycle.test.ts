import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoPatientIntakeEdge } from "../../src/cliniko/patient-intake.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { intakeCredential, intakeDeferred, intakeDraft, intakeEdgeFixture } from "../support/intake-edge.ts";

test("E2E-292 actual intake authority creates once, observes the same exact phone/type and returns no draft or private chart", async () => {
  const f = await intakeEdgeFixture();
  try {
    assert.deepEqual(await f.create(), { ok: true, value: { kind: "created", patientRef: "cliniko:patient:42" } });
    assert.deepEqual(f.traffic, ["GET /v1/patients", "POST /v1/patients", "GET /v1/patients/42"]);
    assert.equal(f.posts, 1); assert.ok(f.row, "successful intake remains in the provider");
    assert.deepEqual(await f.create(), { ok: false, error: { kind: "invalidQuery" } });
  } finally { f.close(); }
});

test("E2E-292 missing, changed, malformed, extra or wrong-type phone evidence never issues a created receipt", async () => {
  for (const phase of ["create", "observe"] as const) for (const phone of [undefined, null,
    [], [{ number: "+61499999999", phone_type: "Mobile" }], [{ number: intakeDraft.patientPhone, phone_type: "Home" }],
    [{ number: intakeDraft.patientPhone, phone_type: "Mobile" }, { number: "+61499999999", phone_type: "Work" }],
    [{ number: "private malformed phone", phone_type: "Mobile" }]]) {
    const f = await intakeEdgeFixture();
    f.intercept((method, path, _signal, body) => {
      if ((phase === "create" && method === "POST") || (phase === "observe" && path.endsWith("/42"))) {
        return Response.json({ ...(body ?? f.row), id: "42", archived_at: null, patient_phone_numbers: phone },
          { status: method === "POST" ? 201 : 200 });
      }
      return undefined;
    });
    try {
      assert.deepEqual(await f.create(), { ok: true, value: { kind: "uncertain" } });
      assert.equal(f.traffic.filter(value => value.startsWith("POST")).length, 1);
      assert.equal(f.traffic.includes("GET /v1/patients/42"), phase === "observe");
      assert.deepEqual(await f.create(), { ok: false, error: { kind: "invalidQuery" } });
    } finally { f.close(); }
  }
});

test("E2E-292 local/international formatting matches under an explicit country code and foreign observation identity stays uncertain", async () => {
  const f = await intakeEdgeFixture();
  f.intercept((method, path, _signal, body) => method === "POST" || path.endsWith("/42")
    ? Response.json({ ...(body ?? f.row), ...(!body ? {
      first_name: intakeDraft.firstName, last_name: intakeDraft.lastName, email: intakeDraft.email,
      date_of_birth: intakeDraft.dateOfBirth, accepted_privacy_policy: true } : {}), id: "42", archived_at: null,
      patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }] }, { status: method === "POST" ? 201 : 200 }) : undefined);
  try { assert.deepEqual(await f.create(), { ok: true, value: { kind: "created", patientRef: "cliniko:patient:42" } }); }
  finally { f.close(); }
  const wrong = await intakeEdgeFixture();
  wrong.intercept((_method, path) => path.endsWith("/42") ? Response.json({ ...wrong.row, id: "99" }) : undefined);
  try { assert.deepEqual(await wrong.create(), { ok: true, value: { kind: "uncertain" } }); assert.equal(wrong.posts, 1); }
  finally { wrong.close(); }
});

test("E2E-292 pre-aborted, stalled authority and stalled duplicate search cannot send later or produce a receipt", async () => {
  for (const stage of ["before", "authority", "sendAuthority", "duplicate"] as const) {
    const f = await intakeEdgeFixture(), entered = intakeDeferred<void>(), release = intakeDeferred<void>();
    const abort = new AbortController();
    if (stage === "before") abort.abort();
    if (stage === "authority") f.holdEvidence(async () => { entered.resolve(); await release.promise; });
    if (stage === "sendAuthority") f.intercept(() => {
      f.holdEvidence(async () => { entered.resolve(); await release.promise; }); return undefined;
    });
    if (stage === "duplicate") f.intercept(async (method) => {
      if (method === "GET") { entered.resolve(); await release.promise; return Response.json({ total_entries: 0, patients: [] }); }
      return undefined;
    });
    try {
      const pending = f.create({ signal: abort.signal });
      if (stage !== "before") { await entered.promise; abort.abort(); }
      assert.deepEqual(await pending, { ok: false, error: { kind: "unavailable" } });
      release.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(f.posts, 0); assert.equal(f.traffic.some(row => row.startsWith("POST")), false);
      assert.deepEqual(await f.create(), { ok: false, error: { kind: "invalidQuery" } });
    } finally { f.close(); }
  }
});

test("E2E-292 stalled pre-send and observation budget claims are fenced; denial after possible create stays uncertain", async () => {
  for (const claim of [1, 2, 3]) {
    let claims = 0;
    const entered = intakeDeferred<void>(), release = intakeDeferred<void>();
    const f = await intakeEdgeFixture({ claim: async () => {
      if (++claims === claim) { entered.resolve(); await release.promise; }
      return null;
    }, observe429: () => ({ kind: "rateLimited" }) });
    try {
      const pending = f.create(); await entered.promise; f.close();
      assert.deepEqual(await pending, claim < 3 ? { ok: false, error: { kind: "unavailable" } } : { ok: true, value: { kind: "uncertain" } });
      release.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(f.posts, claim < 3 ? 0 : 1);
      assert.equal(f.traffic.includes("GET /v1/patients/42"), false);
    } finally { f.close(); }
  }
  const f = await intakeEdgeFixture(new ClinikoReadBudget(2));
  try { assert.deepEqual(await f.create(), { ok: true, value: { kind: "uncertain" } }); assert.equal(f.posts, 1); }
  finally { f.close(); }
});

test("E2E-292 exact read-back rejects changed name, mailbox, DOB, privacy and archive state while retaining the provider patient", async () => {
  for (const changed of [{ first_name: "SomeoneElse" }, { last_name: "Changed" }, { email: "other@example.test" },
    { date_of_birth: "1988-06-21" }, { accepted_privacy_policy: false }, { archived_at: "2026-10-04T12:00:00Z" }]) {
    const f = await intakeEdgeFixture();
    f.intercept((_method, path) => path.endsWith("/42") ? Response.json({ ...f.row, ...changed }) : undefined);
    try {
      assert.deepEqual(await f.create(), { ok: true, value: { kind: "uncertain" } });
      assert.equal(f.posts, 1); assert.ok(f.row); assert.equal(f.traffic.some(row => row.includes("archive") || row.startsWith("DELETE")), false);
    } finally { f.close(); }
  }
});

test("E2E-292 abort during possible create or exact observation discards a late success without a second patient send", async () => {
  for (const stage of ["create", "observe"] as const) {
    const f = await intakeEdgeFixture(), entered = intakeDeferred<void>(), release = intakeDeferred<void>();
    f.intercept(async (method, path, _signal, body) => {
      if ((stage === "create" && method === "POST") || (stage === "observe" && path.endsWith("/42"))) {
        entered.resolve(); await release.promise;
        return Response.json({ ...(body ?? f.row), id: "42", archived_at: null }, { status: method === "POST" ? 201 : 200 });
      }
      return undefined;
    });
    try {
      const pending = f.create(); await entered.promise; f.close();
      assert.deepEqual(await pending, { ok: true, value: { kind: "uncertain" } });
      release.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(await f.create(), { ok: false, error: { kind: "invalidQuery" } });
      assert.equal(f.traffic.filter(row => row.startsWith("POST")).length, 1);
      assert.equal(f.traffic.includes("GET /v1/patients/42"), stage === "observe");
    } finally { f.close(); }
  }
});

test("E2E-292 one operation deadline bounds noncooperative authority, duplicate body, POST and observation body", async () => {
  for (const stage of ["authority", "duplicateBody", "post", "observationBody"] as const) {
    const f = await intakeEdgeFixture();
    if (stage === "authority") f.holdEvidence(() => new Promise<void>(() => {}));
    else f.intercept((method, path) => {
      if (stage === "post" && method === "POST") return new Promise<Response>(() => {});
      if ((stage === "duplicateBody" && method === "GET") || (stage === "observationBody" && path.endsWith("/42"))) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      return undefined;
    });
    try {
      assert.deepEqual(await f.create({ timeoutMs: 30 }), stage === "authority" || stage === "duplicateBody"
        ? { ok: false, error: { kind: "unavailable" } } : { ok: true, value: { kind: "uncertain" } });
      assert.equal(f.traffic.filter(row => row.startsWith("POST")).length, stage === "authority" || stage === "duplicateBody" ? 0 : 1);
    } finally { f.close(); }
  }
});

test("E2E-292 permission revoked at duplicate read blocks POST and failed exact provider observation never confirms intake", async () => {
  const denied = await intakeEdgeFixture();
  denied.intercept(() => { denied.setEvidence(null); return undefined; });
  try { assert.deepEqual(await denied.create(), { ok: false, error: { kind: "unauthorized" } }); assert.equal(denied.posts, 0); }
  finally { denied.close(); }
  for (const status of [401, 403, 404, 429, 503]) {
    const f = await intakeEdgeFixture(); f.intercept((_method, path) => path.endsWith("/42") ? new Response(null, { status }) : undefined);
    try { assert.deepEqual(await f.create(), { ok: true, value: { kind: "uncertain" } }); assert.equal(f.posts, 1); }
    finally { f.close(); }
  }
});

test("E2E-292 missing country code, invalid deadline and unnormalizable caller phone deny before provider IO", async () => {
  const f = await intakeEdgeFixture();
  try {
    assert.deepEqual(ClinikoPatientIntakeEdge.create({ scope: f.scope, apiKey: intakeCredential, contactEmail: "owner@example.test",
      countryCallingCode: "" }, f.authority), { ok: false, error: { kind: "invalidConfig" } });
    for (const timeoutMs of [0, 30_001, NaN]) assert.deepEqual(await f.create({ timeoutMs }), { ok: false, error: { kind: "invalidQuery" } });
    assert.deepEqual(await f.edge.createOnce({ ...f.request, patientPhone: "letters only" }), { ok: false, error: { kind: "invalidQuery" } });
    assert.equal(f.traffic.length, 0);
    const proof = await f.authority.attest(f.request, "read"); assert.ok(proof); assert.equal(proof.expiresAt, "2026-10-04T12:05:00.000Z");
  } finally { f.close(); }
});
