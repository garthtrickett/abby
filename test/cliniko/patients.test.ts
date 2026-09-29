import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoPatientFailure, ClinikoPatientSearch } from "../../src/cliniko/patients.ts";
import type { Result } from "../../src/core/model.ts";

const scope = { tenantId: "patient-tenant", clinicId: "patient-clinic" };
const config = { scope, apiKey: "synthetic-key-au5", contactEmail: "dev@example.test" };
const observedAt = "2026-09-28T10:00:00.000Z";
const email = "patient@example.test";
const dateOfBirth = "1990-05-21";

function value(result: Result<ClinikoPatientSearch, ClinikoPatientFailure>): ClinikoPatientSearch {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

function failure(result: Result<unknown, ClinikoPatientFailure>, kind: ClinikoPatientFailure["kind"]): void {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, kind);
}

function patient(id: string, options: Record<string, unknown> = {}) {
  return { id, email, date_of_birth: dateOfBirth, archived_at: null,
    first_name: "Private", last_name: "Person", notes: "Clinical secret", ...options };
}

function provider(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const requests: URL[] = [];
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(url.origin, "https://api.au5.cliniko.com");
    assert.equal(url.pathname, "/v1/patients");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    const requestHeaders = new Headers(init?.headers);
    assert.equal(requestHeaders.get("Accept"), "application/json");
    assert.equal(requestHeaders.get("Authorization"), `Basic ${Buffer.from("synthetic-key-au5:").toString("base64")}`);
    assert.equal(requestHeaders.get("User-Agent"), "Abby (dev@example.test)");
    return status === 200 ? new Response(JSON.stringify(body), { status, headers }) : new Response(null, { status, headers });
  };
  return { fetchPort, requests };
}

function reader(fetchPort: typeof fetch): ClinikoPatientCandidateReader {
  const created = ClinikoPatientCandidateReader.create(config, fetchPort, () => observedAt);
  assert.equal(created.ok, true);
  return created.value;
}

test("Cliniko HTTP candidate search returns one opaque reference without patient details or proof", async () => {
  const fake = provider({ total_entries: 1, patients: [patient("22")] });
  const result = value(await reader(fake.fetchPort).findByEmailAndBirthDate(scope, email, dateOfBirth));
  assert.deepEqual(result, { kind: "one", scope, observedAt, candidateRef: "cliniko:patient:22" });
  assert.equal(JSON.stringify(result).includes("Private"), false);
  assert.equal(JSON.stringify(result).includes("Clinical"), false);
  assert.equal("verificationRef" in result, false);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]!.searchParams.get("per_page"), "2");
  assert.deepEqual(fake.requests[0]!.searchParams.getAll("q[]"),
    [`email:=${email}`, `date_of_birth:=${dateOfBirth}`]);
  assert.equal(fake.requests[0]!.searchParams.toString().includes("phone"), false);
});

test("no match and multiple matches cannot become verified patient evidence", async () => {
  const none = provider({ total_entries: 0, patients: [] });
  assert.deepEqual(value(await reader(none.fetchPort).findByEmailAndBirthDate(scope, email, dateOfBirth)),
    { kind: "none", scope, observedAt });
  const many = provider({ total_entries: 3, patients: [patient("22"), patient("23")] });
  assert.deepEqual(value(await reader(many.fetchPort).findByEmailAndBirthDate(scope, email, dateOfBirth)),
    { kind: "ambiguous", scope, observedAt });
});

test("foreign scope and non-exact clues fail before any patient HTTP request", async () => {
  const fake = provider({ total_entries: 1, patients: [patient("22")] });
  const adapter = reader(fake.fetchPort);
  failure(await adapter.findByEmailAndBirthDate({ ...scope, tenantId: "other" }, email, dateOfBirth), "scopeMismatch");
  failure(await adapter.findByEmailAndBirthDate(scope, "patient@example.test%", dateOfBirth), "invalidQuery");
  failure(await adapter.findByEmailAndBirthDate(scope, email, "1990-02-30"), "invalidQuery");
  failure(await adapter.findByEmailAndBirthDate(scope, email, "1990-**-**"), "invalidQuery");
  assert.equal(fake.requests.length, 0);
});

test("provider filter drift or an incomplete page fails closed", async () => {
  for (const body of [
    { total_entries: 1, patients: [patient("22", { email: "different@example.test" })] },
    { total_entries: 1, patients: [patient("22", { date_of_birth: "1989-05-21" })] },
    { total_entries: 1, patients: [patient("22", { archived_at: observedAt })] },
    { total_entries: 1, patients: [] },
    { total_entries: 2, patients: [patient("22"), patient("22")] },
  ]) {
    const fake = provider(body);
    failure(await reader(fake.fetchPort).findByEmailAndBirthDate(scope, email, dateOfBirth), "malformed");
  }
});

test("permission, rate limit, transport, and oversized responses have typed failures", async () => {
  for (const [status, expected] of [[401, "forbidden"], [403, "forbidden"], [404, "unavailable"],
    [429, "rateLimited"], [503, "unavailable"]] as const) {
    const fake = provider({}, status);
    failure(await reader(fake.fetchPort).findByEmailAndBirthDate(scope, email, dateOfBirth), expected);
  }
  const failedFetch: typeof fetch = async () => { throw new Error("network failed"); };
  failure(await reader(failedFetch).findByEmailAndBirthDate(scope, email, dateOfBirth), "unavailable");
  const oversized = provider({ total_entries: 1, patients: [patient("22", { notes: "x".repeat(1_000_000) })] });
  failure(await reader(oversized.fetchPort).findByEmailAndBirthDate(scope, email, dateOfBirth), "tooManyResults");
  const limited = provider({}, 429, { "X-RateLimit-Reset": "1893456000" });
  const result = await reader(limited.fetchPort).findByEmailAndBirthDate(scope, email, dateOfBirth);
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, { kind: "rateLimited", resetAt: new Date(1893456000 * 1000).toISOString() });
});

test("phone snapshot retries the same page after provider 429 and bounds repeated resets", async () => {
  let clock = Date.parse("2026-09-29T00:00:00.000Z");
  let requests = 0;
  const makeReader = (fetchPort: typeof fetch) => {
    const created = ClinikoPatientCandidateReader.create({ ...config,
      rateBudget: new ClinikoReadBudget(200, () => clock) }, fetchPort, () => new Date(clock).toISOString());
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("reader expected");
    return created.value;
  };
  const waitUntil = async (resetAt: string) => { clock = Date.parse(resetAt); };
  const recovered = makeReader(async () => {
    requests += 1;
    return requests === 1
      ? new Response(null, { status: 429, headers: { "X-RateLimit-Reset": String((clock + 60_000) / 1000) } })
      : Response.json({ total_entries: 1, patients: [{ id: "81", archived_at: null,
        patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }] }] });
  });
  const snapshot = await recovered.readPhoneSnapshot(scope, "61", 100_000, waitUntil);
  assert.deepEqual(snapshot.ok ? snapshot.value.links : snapshot, [{ normalizedPhone: "+61400111222", patientId: "81" }]);
  assert.equal(requests, 2);

  requests = 0;
  const repeated = makeReader(async () => {
    requests += 1;
    return new Response(null, { status: 429,
      headers: { "X-RateLimit-Reset": String((clock + 60_000) / 1000) } });
  });
  failure(await repeated.readPhoneSnapshot(scope, "61", 100_000, waitUntil), "rateLimited");
  assert.equal(requests, 13);
});

test("phone snapshot deduplicates repeated numbers for one patient before its link limit", async () => {
  const created = ClinikoPatientCandidateReader.create(config, async () => Response.json({
    total_entries: 1, patients: [{ id: "82", archived_at: null,
      patient_phone_numbers: [
        { number: "0400 111 222", phone_type: "Mobile" },
        { number: "+61 400 111 222", phone_type: "Home" },
      ] }],
  }));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const result = await created.value.readPhoneSnapshot(scope, "61");
  assert.deepEqual(result.ok ? result.value.links : result, [{ normalizedPhone: "+61400111222", patientId: "82" }]);
});
