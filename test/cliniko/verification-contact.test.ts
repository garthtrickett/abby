import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoVerificationContactReader } from "../../src/cliniko/verification-contact.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";

const scope = { tenantId: "contact-tenant", clinicId: "clinic", locationId: "location" };
const config = { scope, apiKey: "synthetic-contact-key-au5", contactEmail: "test@example.test", countryCallingCode: "61" };
const phone = "+61400111222";
const patient = () => ({ id: "42", archived_at: null, email: "Patient@EXAMPLE.test",
  patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }], notes: "private-chart-canary" });

test("E2E-269 fresh Cliniko contact read checks scope/id/active phone and projects only a transient canonical email", async () => {
  let reads = 0;
  const reader = new ClinikoVerificationContactReader(config, async (url, init) => {
    reads += 1; assert.equal(String(url), "https://api.au5.cliniko.com/v1/patients/42");
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("User-Agent"), "Abby (test@example.test)");
    return Response.json(patient());
  });
  assert.deepEqual(await reader.read(scope, "42", phone, new AbortController().signal), { ok: true, value: "Patient@example.test" });
  for (const [candidateScope, id] of [[{ ...scope, tenantId: "other" }, "42"], [scope, "../42"]] as const) {
    assert.equal((await reader.read(candidateScope, id, phone, new AbortController().signal)).ok, false);
  }
  const aborted = new AbortController(); aborted.abort(); assert.equal((await reader.read(scope, "42", phone, aborted.signal)).ok, false);
  assert.equal(reads, 1);
});

test("E2E-269 archived, changed/malformed phone, wrong patient, invalid email and oversized/private responses deny contact", async () => {
  const changed: unknown[] = [{ ...patient(), archived_at: "2026-10-04T04:00:00Z" }, { ...patient(), id: "43" },
    { ...patient(), email: "attacker@example.test\r\nBcc: other@example.test" }, { ...patient(), email: null },
    { ...patient(), patient_phone_numbers: [{ number: phone, phone_type: "Fax" }] },
    { ...patient(), patient_phone_numbers: [{ number: null, phone_type: "Mobile" }] },
    { ...patient(), patient_phone_numbers: [{ number: 4 }] },
    { ...patient(), patient_phone_numbers: Array(21).fill({ number: phone, phone_type: "Mobile" }) }];
  for (const value of changed) {
    const reader = new ClinikoVerificationContactReader(config, async () => Response.json(value));
    assert.deepEqual(await reader.read(scope, "42", phone, new AbortController().signal), { ok: false, error: { kind: "denied" } });
  }
  for (const response of [new Response("{"), new Response("x".repeat(1_000_001)), new Response(null, { status: 503 })]) {
    const reader = new ClinikoVerificationContactReader(config, async () => response);
    const result = await reader.read(scope, "42", phone, new AbortController().signal); assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("private-chart-canary"), false);
  }
});

test("E2E-269 shared provider cooldown, unavailable budget and abort while reserving forbid patient reads", async () => {
  let reads = 0;
  const budget = new ClinikoReadBudget(1);
  const reader = new ClinikoVerificationContactReader({ ...config, rateBudget: budget }, async () => { reads += 1; return new Response(null, { status: 429 }); });
  assert.equal((await reader.read(scope, "42", phone, new AbortController().signal)).ok, false);
  assert.equal((await reader.read(scope, "42", phone, new AbortController().signal)).ok, false); assert.equal(reads, 1);
  let release: (value: null) => void = () => undefined;
  const held = new ClinikoVerificationContactReader({ ...config, rateBudget: {
    claim: () => new Promise<null>(resolve => { release = resolve; }), observe429: () => ({ kind: "rateLimited" }) } },
    async () => { reads += 1; return Response.json(patient()); });
  const controller = new AbortController(); const pending = held.read(scope, "42", phone, controller.signal);
  controller.abort(); release(null); assert.equal((await pending).ok, false); assert.equal(reads, 1);
});
