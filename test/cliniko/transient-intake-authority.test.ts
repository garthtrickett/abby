import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoPatientIntakeEdge } from "../../src/cliniko/patient-intake.ts";
import type { ClinikoIntakeRequest } from "../../src/cliniko/patient-intake.ts";
import { TransientIntakeAuthority } from "../../src/standalone/transient-intake-authority.ts";
import type { HostIntakeEvidence, IntakeEvidenceSource } from "../../src/standalone/transient-intake-authority.ts";
import { err, ok } from "../../src/core/model.ts";

const scope = { tenantId: "tenant", clinicId: "clinic", locationId: "location" };
const now = "2026-10-01T10:00:00.000Z";
const refs = ["draft:one", "consent:one", "authority:one"] as const;
const baseEvidence: HostIntakeEvidence = { scope, callId: "call:one", sessionId: "session:one",
  policyVersion: "intake-policy:1", draftRef: refs[0], consentRef: refs[1], authorityRef: refs[2],
  draft: { firstName: "Synthetic", lastName: "Patient", email: "synthetic@example.test",
    dateOfBirth: "1990-05-21", patientPhone: "0400 111 222", phoneType: "Mobile" },
  caller: "patient", privacyAccepted: true, proxyAuthorized: false,
  expiresAt: "2026-10-01T10:05:00.000Z" };

function authority(source: IntakeEvidenceSource): TransientIntakeAuthority {
  return new TransientIntakeAuthority({ scope, callId: "call:one", sessionId: "session:one",
    policyVersion: "intake-policy:1", source, clock: () => now });
}

function clinicianSource(read: () => HostIntakeEvidence | null): IntakeEvidenceSource {
  return { async resolve(input) {
    assert.equal(input.scope.locationId, scope.locationId);
    assert.equal(input.callId, "call:one");
    assert.equal(input.sessionId, "session:one");
    assert.deepEqual([input.draftRef, input.consentRef, input.authorityRef], refs);
    const evidence = read();
    return evidence ? ok(evidence) : err({ kind: "denied" });
  } };
}

async function prepared(host: TransientIntakeAuthority): Promise<ClinikoIntakeRequest> {
  const result = await host.prepare(...refs);
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

test("trusted transient host evidence permits exactly one scoped Cliniko create", async () => {
  let reads = 0;
  let posts = 0;
  const host = authority(clinicianSource(() => { reads += 1; return baseEvidence; }));
  const request = await prepared(host);
  assert.equal(request.scope.locationId, scope.locationId);
  assert.equal(request.callId, "call:one");
  assert.equal(request.caller, "patient");
  assert.equal(JSON.stringify(await host.prepare(...refs)).includes("Synthetic"), false);
  const created = ClinikoPatientIntakeEdge.create({ scope, countryCallingCode: "61", apiKey: "synthetic-key-au5",
    contactEmail: "dev@example.test" }, host, async (_input, init) => {
    if (new URL(String(_input)).pathname.endsWith("/42")) return Response.json({ id: "42",
      first_name: request.firstName, last_name: request.lastName, email: request.email, date_of_birth: request.dateOfBirth,
      patient_phone_numbers: [{ number: request.patientPhone, phone_type: request.phoneType }],
      accepted_privacy_policy: true, archived_at: null });
    if (init?.method === "GET") return Response.json({ total_entries: 0, patients: [] });
    posts += 1;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.first_name, "Synthetic");
    assert.equal(body.accepted_privacy_policy, true);
    return Response.json({ id: "42", first_name: body.first_name, last_name: body.last_name,
      email: body.email, date_of_birth: body.date_of_birth,
      patient_phone_numbers: [{ number: request.patientPhone, phone_type: request.phoneType }],
      accepted_privacy_policy: true, archived_at: null }, { status: 201 });
  }, () => now);
  assert.equal(created.ok, true);
  assert.deepEqual(await created.value.createOnce(request),
    { ok: true, value: { kind: "created", patientRef: "cliniko:patient:42" } });
  assert.equal(posts, 1);
  assert.equal(reads, 3, "prepare, before duplicate search, before create");
  assert.deepEqual(await created.value.createOnce(request),
    { ok: false, error: { kind: "invalidQuery" } });
  host.dispose();
  assert.equal(await host.attest(request, "read"), null);
});

test("consent revocation while Cliniko answers the duplicate search prevents creation", async () => {
  let evidence: HostIntakeEvidence | null = baseEvidence;
  let posts = 0;
  const host = authority(clinicianSource(() => evidence));
  const request = await prepared(host);
  const created = ClinikoPatientIntakeEdge.create({ scope, countryCallingCode: "61", apiKey: "synthetic-key-au5",
    contactEmail: "dev@example.test" }, host, async (_input, init) => {
    if (new URL(String(_input)).pathname.endsWith("/42")) return Response.json({ id: "42",
      first_name: request.firstName, last_name: request.lastName, email: request.email, date_of_birth: request.dateOfBirth,
      patient_phone_numbers: [{ number: request.patientPhone, phone_type: request.phoneType }],
      accepted_privacy_policy: true, archived_at: null });
    if (init?.method === "GET") {
      evidence = null;
      return Response.json({ total_entries: 0, patients: [] });
    }
    posts += 1;
    throw new Error("unexpected patient create");
  }, () => now);
  assert.equal(created.ok, true);
  assert.deepEqual(await created.value.createOnce(request),
    { ok: false, error: { kind: "unauthorized" } });
  assert.equal(posts, 0);
  host.dispose();
});

test("two writer instances sharing one call authority cannot both create", async () => {
  const host = authority(clinicianSource(() => baseEvidence));
  const request = await prepared(host);
  let posts = 0;
  const provider: typeof fetch = async (_input, init) => {
    if (new URL(String(_input)).pathname.endsWith("/42")) return Response.json({ id: "42",
      first_name: request.firstName, last_name: request.lastName, email: request.email, date_of_birth: request.dateOfBirth,
      patient_phone_numbers: [{ number: request.patientPhone, phone_type: request.phoneType }],
      accepted_privacy_policy: true, archived_at: null });
    if (init?.method === "GET") return Response.json({ total_entries: 0, patients: [] });
    posts += 1;
    return Response.json({ id: "42", first_name: request.firstName, last_name: request.lastName,
      email: request.email, date_of_birth: request.dateOfBirth,
      patient_phone_numbers: [{ number: request.patientPhone, phone_type: request.phoneType }],
      accepted_privacy_policy: true, archived_at: null }, { status: 201 });
  };
  const config = { scope, countryCallingCode: "61", apiKey: "synthetic-key-au5", contactEmail: "dev@example.test" };
  const first = ClinikoPatientIntakeEdge.create(config, host, provider, () => now);
  const second = ClinikoPatientIntakeEdge.create(config, host, provider, () => now);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const results = await Promise.all([first.value.createOnce(request), second.value.createOnce(request)]);
  assert.deepEqual(results.map(result => result.ok ? result.value.kind : result.error.kind).sort(),
    ["created", "unauthorized"]);
  assert.equal(posts, 1);
  host.dispose();
});

test("interrupted consent, unapproved proxy, wrong call and changed draft do not authorize intake", async () => {
  for (const evidence of [
    { ...baseEvidence, privacyAccepted: false },
    { ...baseEvidence, caller: "proxy" as const, proxyAuthorized: false },
    { ...baseEvidence, callId: "call:other" },
    { ...baseEvidence, scope: { ...scope, locationId: "other" } },
    { ...baseEvidence, expiresAt: now },
  ]) {
    const host = authority(clinicianSource(() => evidence));
    assert.deepEqual(await host.prepare(...refs), { ok: false, error: { kind: "denied" } });
    host.dispose();
  }
  let evidence: HostIntakeEvidence = baseEvidence;
  const host = authority(clinicianSource(() => evidence));
  const request = await prepared(host);
  evidence = { ...baseEvidence, draft: { ...baseEvidence.draft, firstName: "Changed" } };
  assert.equal(await host.attest(request, "read"), null);
  assert.equal(await host.attest({ ...request, sessionId: "session:other" }, "read"), null);
  host.dispose();
});

test("host outage remains typed and disconnect during evidence resolution cannot prepare intake", async () => {
  const unavailable = authority({ async resolve() { return err({ kind: "unavailable" }); } });
  assert.deepEqual(await unavailable.prepare(...refs),
    { ok: false, error: { kind: "unavailable" } });
  unavailable.dispose();

  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const interrupted = authority({ async resolve() {
    entered();
    await waiting;
    return ok(baseEvidence);
  } });
  const pending = interrupted.prepare(...refs);
  await enteredPromise;
  interrupted.dispose();
  release();
  assert.deepEqual(await pending, { ok: false, error: { kind: "disconnected" } });
});

test("E2E-292 consumer abort or owner disposal releases held evidence immediately and late approval cannot claim a send", async () => {
  for (const stage of ["prepare", "attest"] as const) for (const stop of ["consumer", "owner"] as const) {
    let held = false, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const host = authority({ async resolve() { if (held) { entered(); await waiting; } return ok(baseEvidence); } });
    const request = stage === "attest" ? await prepared(host) : undefined;
    held = true; const controller = new AbortController();
    const pending = stage === "prepare" ? host.prepare(...refs, controller.signal) : host.attest(request!, "send", controller.signal);
    await started;
    if (stop === "consumer") controller.abort(); else host.dispose();
    assert.deepEqual(await pending, stage === "attest" ? null :
      { ok: false, error: { kind: stop === "owner" ? "disconnected" : "unavailable" } });
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    if (stage === "attest" && stop === "consumer") assert.ok(await host.attest(request!, "send"), "abandoned approval did not mint or consume a send claim");
    host.dispose();
  }
});

test("E2E-292 a changing input and extra runtime draft keys cannot replace trusted call, scope or consent bindings", async () => {
  const injected = { ...baseEvidence, draft: { ...baseEvidence.draft,
    callId: "call:forged", sessionId: "session:forged", scope: { ...scope, clinicId: "forged" },
    policyVersion: "forged", consentRef: "forged", authorityRef: "forged", attemptRef: "forged" } };
  let held = false, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const host = authority({ async resolve() { if (held) { entered(); await waiting; } return ok(injected); } });
  const request = await prepared(host);
  assert.equal(request.callId, baseEvidence.callId); assert.equal(request.sessionId, baseEvidence.sessionId);
  assert.deepEqual(request.scope, scope); assert.equal(request.consentRef, refs[1]); assert.notEqual(request.attemptRef, "forged");
  const mutable = structuredClone(request) as { -readonly [Key in keyof ClinikoIntakeRequest]: ClinikoIntakeRequest[Key] };
  held = true; const pending = host.attest(mutable, "read"); await started;
  mutable.callId = "call:changed"; mutable.consentRef = "consent:changed"; mutable.firstName = "Changed";
  release(); const proof = await pending; assert.ok(proof);
  assert.equal(proof.callId, baseEvidence.callId); assert.equal(proof.consentRef, refs[1]);
  host.dispose();
});

test("E2E-292 malformed refreshed draft denies an attestation instead of throwing private host detail", async () => {
  let evidence = baseEvidence;
  const host = authority(clinicianSource(() => evidence));
  const request = await prepared(host);
  evidence = { ...baseEvidence, draft: null } as unknown as HostIntakeEvidence;
  assert.equal(await host.attest(request, "send"), null);
  host.dispose();
});
