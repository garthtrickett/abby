import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoPatientIntakeEdge, clinikoIntakeDraftDigest } from "../../src/cliniko/patient-intake.ts";
import type { ClinikoIntakeAttestation, ClinikoIntakeAuthority, ClinikoIntakeRequest } from "../../src/cliniko/patient-intake.ts";

const scope = { tenantId: "intake-tenant", clinicId: "intake-clinic", locationId: "intake-location" };
const config = { scope, apiKey: "synthetic-key-au5", contactEmail: "dev@example.test" };
const request: ClinikoIntakeRequest = {
  scope, callId: "call:one", sessionId: "session:one", attemptRef: "intake:one",
  policyVersion: "intake-policy:1", firstName: "First", lastName: "Patient",
  email: "patient@example.test", dateOfBirth: "1990-05-21", patientPhone: "0400 111 222",
  phoneType: "Mobile",
  caller: "patient", consentRef: "host:consent:one", authorityRef: "host:authority:one",
};

const now = "2026-10-01T10:00:00.000Z";
function attestation(input: ClinikoIntakeRequest): ClinikoIntakeAttestation {
  return { scope: input.scope, callId: input.callId, sessionId: input.sessionId,
    attemptRef: input.attemptRef, policyVersion: input.policyVersion,
    draftDigest: clinikoIntakeDraftDigest(input), caller: input.caller,
    consentRef: input.consentRef, authorityRef: input.authorityRef,
    privacyAccepted: true, proxyAuthorized: input.caller === "proxy",
    expiresAt: "2026-10-01T10:05:00.000Z" };
}
function edge(fetchPort: typeof fetch, authority: ClinikoIntakeAuthority = { attest: async input => attestation(input) }): ClinikoPatientIntakeEdge {
  const result = ClinikoPatientIntakeEdge.create(config, authority, fetchPort, () => now);
  assert.equal(result.ok, true);
  return result.value;
}

function candidateList(total: number) {
  return { total_entries: total, patients: Array.from({ length: Math.min(total, 2) }, (_, index) => ({
    id: String(index + 1), email: request.email, date_of_birth: request.dateOfBirth, archived_at: null,
  })) };
}

test("first-time intake checks exact candidates and returns only the Cliniko patient reference", async () => {
  const methods: string[] = [];
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.au5.cliniko.com");
    assert.equal(url.pathname, "/v1/patients");
    methods.push(init?.method ?? "");
    if (init?.method === "GET") {
      assert.deepEqual(url.searchParams.getAll("q[]"),
        [`email:=${request.email}`, `date_of_birth:=${request.dateOfBirth}`]);
      return Response.json(candidateList(0));
    }
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body, { first_name: request.firstName, last_name: request.lastName,
      date_of_birth: request.dateOfBirth, email: request.email,
      patient_phone_numbers: [{ number: request.patientPhone, phone_type: request.phoneType }],
      accepted_privacy_policy: true });
    return Response.json({ id: "42", first_name: request.firstName, last_name: request.lastName,
      email: request.email, date_of_birth: request.dateOfBirth, accepted_privacy_policy: true,
      archived_at: null, notes: "private Cliniko note" }, { status: 201 });
  };
  const result = await edge(fetchPort).createOnce(request);
  assert.deepEqual(result, { ok: true, value: { kind: "created", patientRef: "cliniko:patient:42" } });
  assert.equal(JSON.stringify(result).includes("private Cliniko note"), false);
  assert.deepEqual(methods, ["GET", "POST"]);
});

test("existing or ambiguous patients, including a household proxy, never trigger create", async () => {
  for (const [total, kind] of [[1, "existingCandidate"], [2, "ambiguous"]] as const) {
    let posts = 0;
    const fetchPort: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") { posts += 1; throw new Error("unexpected create"); }
      return Response.json(candidateList(total));
    };
    const result = await edge(fetchPort).createOnce({ ...request, caller: "proxy" });
    assert.deepEqual(result, { ok: true, value: { kind } });
    assert.equal(posts, 0);
  }
});

test("absent consent, invalid identity, and foreign scope fail before HTTP", async () => {
  let calls = 0;
  const adapter = edge(async () => { calls += 1; throw new Error("unexpected HTTP"); });
  for (const invalid of [
    { ...request, consentRef: "" },
    { ...request, authorityRef: "" },
    { ...request, policyVersion: "" },
    { ...request, dateOfBirth: "1990-02-30" },
  ]) {
    const result = await adapter.createOnce(invalid as ClinikoIntakeRequest);
    assert.deepEqual(result, { ok: false, error: { kind: "invalidQuery" } });
  }
  const foreign = await adapter.createOnce({ ...request, scope: { ...scope, clinicId: "other" } });
  assert.deepEqual(foreign, { ok: false, error: { kind: "scopeMismatch" } });
  assert.equal(calls, 0);
});

test("trusted host must bind draft, consent, proxy authority, scope, policy and expiry before any Cliniko read", async () => {
  const invalidAttestations = [
    null,
    { ...attestation(request), draftDigest: "0".repeat(64) },
    { ...attestation(request), consentRef: "host:consent:other" },
    { ...attestation(request), policyVersion: "intake-policy:old" },
    { ...attestation(request), callId: "call:other" },
    { ...attestation(request), sessionId: "session:other" },
    { ...attestation(request), scope: { ...scope, clinicId: "other" } },
    { ...attestation(request), scope: { ...scope, locationId: "other" } },
    { ...attestation(request), expiresAt: now },
    { ...attestation(request), privacyAccepted: false },
    { ...attestation({ ...request, caller: "proxy" }), proxyAuthorized: false },
  ];
  let calls = 0;
  for (const [index, proof] of invalidAttestations.entries()) {
    const input = index === invalidAttestations.length - 1 ? { ...request, caller: "proxy" as const } : request;
    const adapter = edge(async () => { calls += 1; throw new Error("unexpected HTTP"); },
      { attest: async () => proof as ClinikoIntakeAttestation | null });
    assert.deepEqual(await adapter.createOnce(input), { ok: false, error: { kind: "unauthorized" } });
  }
  assert.equal(calls, 0);
});

test("revoked consent after duplicate check stops before patient creation", async () => {
  let checks = 0;
  const methods: string[] = [];
  const adapter = edge(async (_input, init) => {
    methods.push(init?.method ?? "");
    if (init?.method === "GET") return Response.json(candidateList(0));
    throw new Error("unexpected create");
  }, { attest: async input => ++checks === 1 ? attestation(input) : null });
  assert.deepEqual(await adapter.createOnce(request), { ok: false, error: { kind: "unauthorized" } });
  assert.equal(checks, 2);
  assert.deepEqual(methods, ["GET"]);
});

test("changing the caller's draft during host attestation cannot alter the authorized POST", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const mutable = structuredClone(request) as { -readonly [K in keyof ClinikoIntakeRequest]: ClinikoIntakeRequest[K] };
  const postedNames: string[] = [];
  const adapter = edge(async (_input, init) => {
    if (init?.method === "GET") return Response.json(candidateList(0));
    const body = JSON.parse(String(init?.body));
    postedNames.push(body.first_name);
    return Response.json({ id: "42", first_name: request.firstName, last_name: request.lastName,
      email: request.email, date_of_birth: request.dateOfBirth,
      accepted_privacy_policy: true, archived_at: null }, { status: 201 });
  }, { attest: async input => {
    entered();
    await waiting;
    return attestation(input);
  } });
  const pending = adapter.createOnce(mutable);
  await enteredPromise;
  mutable.firstName = "Changed";
  release();
  assert.deepEqual(await pending, { ok: true, value: { kind: "created", patientRef: "cliniko:patient:42" } });
  assert.deepEqual(postedNames, ["First"]);
});

test("create timeout remains uncertain and cannot send again through the same edge", async () => {
  const methods: string[] = [];
  const adapter = edge(async (_input, init) => {
    methods.push(init?.method ?? "");
    if (init?.method === "GET") return Response.json(candidateList(0));
    throw new Error("response lost after possible commit");
  });
  assert.deepEqual(await adapter.createOnce(request), { ok: true, value: { kind: "uncertain" } });
  assert.deepEqual(await adapter.createOnce(request), { ok: false, error: { kind: "invalidQuery" } });
  assert.deepEqual(methods, ["GET", "POST"]);
});

test("a mismatched create response cannot produce a patient receipt", async () => {
  const adapter = edge(async (_input, init) => init?.method === "GET"
    ? Response.json(candidateList(0))
    : Response.json({ id: "42", first_name: request.firstName, last_name: "Another",
      email: request.email, date_of_birth: request.dateOfBirth,
      accepted_privacy_policy: true, archived_at: null }, { status: 201 }));
  assert.deepEqual(await adapter.createOnce(request), { ok: true, value: { kind: "uncertain" } });
});
