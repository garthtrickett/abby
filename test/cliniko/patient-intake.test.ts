import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoPatientIntakeEdge } from "../../src/cliniko/patient-intake.ts";
import type { ClinikoIntakeRequest } from "../../src/cliniko/patient-intake.ts";

const scope = { tenantId: "intake-tenant", clinicId: "intake-clinic" };
const config = { scope, apiKey: "synthetic-key-au5", contactEmail: "dev@example.test" };
const request: ClinikoIntakeRequest = {
  scope, attemptRef: "intake:one", firstName: "First", lastName: "Patient",
  email: "patient@example.test", dateOfBirth: "1990-05-21", patientPhone: "0400 111 222",
  phoneType: "Mobile",
  caller: "patient", consentRef: "host:consent:one", authorityRef: "host:authority:one",
  acceptedPrivacyPolicy: true,
};

function edge(fetchPort: typeof fetch): ClinikoPatientIntakeEdge {
  const result = ClinikoPatientIntakeEdge.create(config, fetchPort);
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

test("interrupted or absent consent, invalid identity, and foreign scope fail before HTTP", async () => {
  let calls = 0;
  const adapter = edge(async () => { calls += 1; throw new Error("unexpected HTTP"); });
  for (const invalid of [
    { ...request, consentRef: "" },
    { ...request, authorityRef: "" },
    { ...request, acceptedPrivacyPolicy: false },
    { ...request, dateOfBirth: "1990-02-30" },
  ]) {
    const result = await adapter.createOnce(invalid as ClinikoIntakeRequest);
    assert.deepEqual(result, { ok: false, error: { kind: "invalidQuery" } });
  }
  const foreign = await adapter.createOnce({ ...request, scope: { ...scope, clinicId: "other" } });
  assert.deepEqual(foreign, { ok: false, error: { kind: "scopeMismatch" } });
  assert.equal(calls, 0);
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
