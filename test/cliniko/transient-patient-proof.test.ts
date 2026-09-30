import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoAppointmentReader } from "../../src/cliniko/appointments.ts";
import { ok, err } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { TransientPatientProofHost } from "../../src/standalone/transient-patient-proof.ts";
import type { PatientAuthority, PatientAuthorityRequest, PatientOperation, VerificationPolicyGate } from "../../src/standalone/transient-patient-proof.ts";
import type { CallerCandidates } from "../../src/voice/caller-candidates.ts";

const scope = { tenantId: "proof-tenant", clinicId: "proof-clinic", locationId: "proof-location" };
const initial = Date.parse("2026-09-30T10:00:00.000Z");
const token = "syntheticHostTokenOne";
let nextCall = 0;

function allow(request: PatientAuthorityRequest, patientId: string,
               operations: readonly PatientOperation[] = [request.operation]) {
  return { scope: request.scope, callId: request.callId, sessionId: request.sessionId,
    policyVersion: request.policyVersion, patientId, operations };
}

function value<T, E>(result: Result<T, E>): T {
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
  return result.value;
}

function failure<T, E extends { kind: string }>(result: Result<T, E>, kind: E["kind"]): void {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, kind);
}

function fixture(options: {
  presentedNumber?: string;
  candidates?: CallerCandidates;
  authority?: PatientAuthority;
  enabled?: boolean;
  version?: string;
  maxAttempts?: 1 | 2 | 3;
  timeoutMs?: number;
  callId?: string;
  policy?: VerificationPolicyGate;
} = {}) {
  let time = initial;
  let enabled = options.enabled ?? true;
  let version = options.version ?? "policy-v1";
  let candidates: CallerCandidates = options.candidates ?? { kind: "one", candidateIds: ["22"] };
  let lookups = 0;
  let attestations = 0;
  const requests: URL[] = [];
  const clock = () => new Date(time).toISOString();
  const authority: PatientAuthority = options.authority ?? { async attest(request) {
    return ok(allow(request, "22"));
  } };
  const sequence = ++nextCall;
  const host = new TransientPatientProofHost({ scope, callId: options.callId ?? `call-${sequence}`,
    sessionId: `session-${sequence}`, presentedCallerNumber: options.presentedNumber === undefined
    ? "+61400111222" : options.presentedNumber, policyVersion: "policy-v1", maxAttempts: options.maxAttempts ?? 3,
  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  lookup: { async candidates() { lookups += 1; return ok(candidates); } },
  authority: { async attest(...args) { attestations += 1; return authority.attest(...args); } },
  policy: options.policy ?? { async current() { return ok({ scope, enabled, version }); } }, clock });
  const provider: typeof fetch = async input => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/v1/businesses/11") {
      return new Response(JSON.stringify({ id: "11", time_zone_identifier: "Australia/Sydney", archived_at: null }));
    }
    assert.equal(url.pathname, "/v1/individual_appointments");
    return new Response(JSON.stringify({ total_entries: 1, individual_appointments: [{
      id: "33", starts_at: "2026-10-01T10:00:00.000Z", ends_at: "2026-10-01T10:30:00.000Z",
      patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/22" } },
      business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } },
      cancelled_at: null, archived_at: null, deleted_at: null,
      patient_name: "Never disclose this", notes: "Private note",
    }] }));
  };
  const reader = value(ClinikoAppointmentReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "dev@example.test", businessId: "11" }, host, provider, clock));
  const read = (verificationRef: string, at = clock()) => reader.list(scope, verificationRef, at,
    new Date(Date.parse(at) + 7 * 86_400_000).toISOString(), at);
  return { host, read, requests, clock, setTime: (ms: number) => { time = ms; },
    setEnabled: (next: boolean) => { enabled = next; }, setVersion: (next: string) => { version = next; },
    setCandidates: (next: CallerCandidates) => { candidates = next; },
    get lookups() { return lookups; }, get attestations() { return attestations; } };
}

test("E2E-189 a phone candidate alone cannot reach appointments; a trusted proof permits one minimal read", async () => {
  const app = fixture();
  failure(await app.read("guessed-reference"), "invalidProof");
  assert.equal(app.requests.length, 0);
  assert.equal(app.attestations, 0);
  const issued = value(await app.host.issue(token, "appointments.read"));
  assert.equal(app.lookups, 2, "the candidate is checked again after attestation");
  assert.equal(app.attestations, 1);
  assert.equal(issued.verificationRef.length >= 40, true);
  assert.equal(JSON.stringify(app.host), "{}", "patient state is not enumerable");
  const found = value(await app.read(issued.verificationRef));
  assert.deepEqual(found.appointments.map(item => item.appointmentRef), ["33"]);
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1]?.searchParams.getAll("q[]").includes("patient_id:=22"), true);
  assert.equal(JSON.stringify(found).includes("Never disclose this"), false);
  assert.equal(JSON.stringify(found).includes("Private note"), false);
});

test("spoofed number with failed authority, shared wrong patient and stale candidates make zero appointment requests", async () => {
  const denied = fixture({ authority: { async attest() { return err({ kind: "denied" as const }); } } });
  failure(await denied.host.issue(token, "appointments.read"), "denied");
  failure(await denied.read("forged"), "invalidProof");
  assert.equal(denied.requests.length, 0);

  const shared = fixture({ candidates: { kind: "multiple", candidateIds: ["22", "23"] },
    authority: { async attest(request) { return ok(allow(request, "24")); } } });
  failure(await shared.host.issue(token, "appointments.read"), "denied");
  failure(await shared.read("forged"), "invalidProof");
  assert.equal(shared.requests.length, 0);

  const replayed = fixture({ authority: { async attest(request) {
    return ok({ ...allow(request, "22"), callId: "another-call" });
  } } });
  failure(await replayed.host.issue(token, "appointments.read"), "denied");
  assert.equal(replayed.requests.length, 0);

  const selected = fixture({ candidates: { kind: "multiple", candidateIds: ["22", "23"] },
    authority: { async attest(request) { return ok(allow(request, "23")); } } });
  const selectedProof = value(await selected.host.issue(token, "appointments.read"));
  assert.equal(value(await selected.host.verifyPatient(scope, selectedProof.verificationRef, selected.clock())).patientRef, "23");
  assert.equal(selected.requests.length, 0, "the verifier may select one patient without reading appointments");

  // A lookup that changes during attestation is rejected by the second candidate read.
  let moving!: ReturnType<typeof fixture>;
  moving = fixture({ authority: { async attest(request) {
    moving.setCandidates({ kind: "indexStale", candidateIds: [] });
    return ok(allow(request, "22"));
  } } });
  failure(await moving.host.issue(token, "appointments.read"), "denied");
  for (const candidates of [
    { kind: "indexStale", candidateIds: [] }, { kind: "none", candidateIds: [] },
    { kind: "tooMany", candidateIds: [] }, { kind: "noNumber", candidateIds: [] },
  ] as CallerCandidates[]) {
    const app = fixture({ candidates });
    failure(await app.host.issue(token, "appointments.read"), "denied");
    assert.equal(app.attestations, 0);
    assert.equal(app.requests.length, 0);
  }
  const anonymous = fixture({ presentedNumber: "" });
  failure(await anonymous.host.issue(token, "appointments.read"), "denied");
  assert.equal(anonymous.lookups, 0);
  assert.equal(anonymous.attestations, 0);
});

test("scope, operation, expiry, policy disable, and withdrawal cannot reuse a proof", async () => {
  const app = fixture();
  const issued = value(await app.host.issue(token, "appointments.read"));
  failure(await app.host.verifyOperation(scope, issued.verificationRef, "appointments.book", app.clock()), "notFound");
  failure(await app.host.verifyPatient({ ...scope, locationId: "other" }, issued.verificationRef, app.clock()), "notFound");
  const otherCall = fixture();
  failure(await otherCall.read(issued.verificationRef), "invalidProof");
  assert.equal(otherCall.requests.length, 0);
  app.setTime(initial + 181_000);
  failure(await app.read(issued.verificationRef), "invalidProof");
  assert.equal(app.requests.length, 0);

  const disabled = fixture();
  const live = value(await disabled.host.issue(token, "appointments.read"));
  disabled.setEnabled(false);
  failure(await disabled.read(live.verificationRef), "unavailable");
  assert.equal(disabled.requests.length, 0);
  const changedPolicy = fixture();
  const changeProof = value(await changedPolicy.host.issue(token, "appointments.read"));
  changedPolicy.setVersion("policy-v2");
  failure(await changedPolicy.read(changeProof.verificationRef), "unavailable");
  assert.equal(changedPolicy.requests.length, 0);

  const withdrawn = fixture();
  const withdrawnProof = value(await withdrawn.host.issue(token, "appointments.read"));
  withdrawn.host.revoke();
  failure(await withdrawn.read(withdrawnProof.verificationRef), "invalidProof");
  withdrawn.host.dispose();
  failure(await withdrawn.host.issue(token, "appointments.read"), "disconnected");
  assert.equal(withdrawn.requests.length, 0);
});

test("attempts are bounded and a late verifier cannot issue after disconnect", async () => {
  const denied = fixture({ maxAttempts: 2, authority: { async attest() { return err({ kind: "denied" as const }); } } });
  failure(await denied.host.issue(token, "appointments.read"), "denied");
  failure(await denied.host.issue(token, "appointments.read"), "denied");
  failure(await denied.host.issue(token, "appointments.read"), "attemptsExhausted");
  assert.equal(denied.attestations, 2);

  let entered!: () => void;
  const underway = new Promise<void>(resolve => { entered = resolve; });
  let release!: (result: Awaited<ReturnType<PatientAuthority["attest"]>>) => void;
  const pending = new Promise<Awaited<ReturnType<PatientAuthority["attest"]>>>(resolve => { release = resolve; });
  let request!: PatientAuthorityRequest;
  const app = fixture({ authority: { async attest(value) { request = value; entered(); return pending; } } });
  const issued = app.host.issue(token, "appointments.read");
  await underway;
  failure(await app.host.issue(token, "appointments.read"), "denied");
  app.host.dispose();
  assert.equal(request.signal.aborted, true);
  release(ok(allow(request, "22")));
  failure(await issued, "disconnected");
  assert.equal(app.requests.length, 0);
});

test("verification timeout is bounded and a late result cannot replace a newer proof", async () => {
  let release!: (result: Awaited<ReturnType<PatientAuthority["attest"]>>) => void;
  const first = new Promise<Awaited<ReturnType<PatientAuthority["attest"]>>>(resolve => { release = resolve; });
  let calls = 0;
  let firstRequest!: PatientAuthorityRequest;
  const app = fixture({ maxAttempts: 2, timeoutMs: 100, authority: { async attest(request) {
    calls += 1;
    if (calls === 1) { firstRequest = request; return first; }
    return ok(allow(request, "22"));
  } } });
  failure(await app.host.issue(token, "appointments.read"), "unavailable");
  const latest = value(await app.host.issue(token, "appointments.read"));
  release(ok(allow(firstRequest, "22")));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(value(await app.host.verifyPatient(scope, latest.verificationRef, app.clock())).patientRef, "22");
  failure(await app.host.issue(token, "appointments.read"), "denied");
  assert.equal(app.requests.length, 0);
});

test("disabled verification performs no candidate lookup or attestation", async () => {
  const app = fixture({ enabled: false });
  failure(await app.host.issue(token, "appointments.read"), "disabled");
  assert.equal(app.lookups, 0);
  assert.equal(app.attestations, 0);
  assert.equal(app.requests.length, 0);
  const misrouted = fixture({ policy: { async current() {
    return ok({ scope: { ...scope, tenantId: "other-tenant" }, enabled: true, version: "policy-v1" });
  } } });
  failure(await misrouted.host.issue(token, "appointments.read"), "disabled");
  assert.equal(misrouted.lookups, 0);
});

test("a stalled policy gate cannot hang a protected appointment read", async () => {
  let checks = 0;
  const app = fixture({ timeoutMs: 100, policy: { async current() {
    checks += 1;
    if (checks <= 2) return ok({ scope, enabled: true, version: "policy-v1" });
    return new Promise<never>(() => undefined);
  } } });
  const issued = value(await app.host.issue(token, "appointments.read"));
  failure(await app.read(issued.verificationRef), "unavailable");
  assert.equal(app.requests.length, 0);
});
