import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoAppointmentReader } from "../../src/cliniko/appointments.ts";
import type { PatientAuthorityRequest } from "../../src/standalone/transient-patient-proof.ts";
import { emailFixture, scope, initial, apiKey } from "../support/email-patient-fixture.ts";

test("E2E-269 email-code verification reaches the existing call-bound proof and protected Cliniko appointment read", async () => {
  const f = emailFixture(); let appointmentReads = 0;
  const reader = ClinikoAppointmentReader.create({ scope, apiKey, contactEmail: "test@example.test", businessId: "11" },
    f.proof, async url => {
      appointmentReads += 1;
      if (String(url).includes("/businesses/11")) return Response.json({ id: "11", archived_at: null, time_zone_identifier: "Australia/Sydney" });
      return Response.json({ total_entries: 0, individual_appointments: [] });
    }, () => new Date(initial).toISOString()); assert.ok(reader.ok);
  const read = (ref: string) => reader.value.list(scope, ref, new Date(initial).toISOString(),
    new Date(initial + 86_400_000).toISOString(), new Date(initial).toISOString());
  assert.equal((await read("guessed-proof")).ok, false); assert.equal(appointmentReads, 0);
  assert.equal(await f.authority.start("appointments.read"), undefined);
  assert.equal(f.mail.length, 1); assert.equal(f.mail[0]!.email, "registered@example.test"); assert.match(f.mail[0]!.code, /^[0-9]{6}$/);
  assert.equal((await f.authority.answer("invalid-code")).ok, false);
  const answered = await f.authority.answer(f.mail[0]!.code); assert.ok(answered.ok);
  assert.equal(JSON.stringify(f.authority), "{}"); assert.equal(JSON.stringify(answered).includes(f.mail[0]!.code), false);
  const issued = await f.proof.issue(answered.value, "appointments.read"); assert.ok(issued.ok);
  const found = await read(issued.value.verificationRef); assert.ok(found.ok); assert.deepEqual(found.value.appointments, []);
  assert.ok(appointmentReads > 0);
  assert.equal((await f.proof.verifyOperation(scope, issued.value.verificationRef, "appointments.cancel", new Date(initial).toISOString())).ok, false);
  assert.equal((await f.authority.answer(f.mail[0]!.code)).ok, false);
  assert.equal(f.reads.every(url => url.endsWith("/patients/42")), true);
});

test("E2E-269 disabled, shared, stale or absent candidates use one generic start result and send no email", async () => {
  for (const kind of ["disabled", "shared", "none", "stale", "wrongPhone", "noEmail", "unapprovedOperation", "oldPolicy", "noPatientAuthority"] as const) {
    const f = emailFixture();
    if (kind === "disabled") f.setEnabled(false);
    if (kind === "shared") f.setCandidates({ kind: "multiple", candidateIds: ["42", "43"] });
    if (kind === "none") f.setCandidates({ kind: "none", candidateIds: [] });
    if (kind === "stale") f.setCandidates({ kind: "indexStale", candidateIds: [] });
    if (kind === "wrongPhone") f.setPhone("+61499999888");
    if (kind === "noEmail") f.setEmail("");
    if (kind === "oldPolicy") f.setVersion("changed");
    if (kind === "noPatientAuthority") f.setPermitted(false);
    assert.equal(await f.authority.start(kind === "unapprovedOperation" ? "appointments.cancel" : "appointments.read"), undefined);
    assert.equal(f.mail.length, 0); assert.equal((await f.authority.answer("123456")).ok, false);
    assert.equal((await f.proof.issue("guessedTokenThatLooksValid", "appointments.read")).ok, false);
  }
});

test("E2E-269 expiry, fresh contact/phone/candidate change and policy revocation cannot mint proof", async () => {
  for (const kind of ["expiry", "email", "phone", "patient", "disabled", "policy", "disconnect", "revokedAuthority"] as const) {
    const f = emailFixture(); await f.authority.start("appointments.read");
    if (kind === "expiry") f.setTime(initial + 300_000);
    if (kind === "email") f.setEmail("changed@example.test");
    if (kind === "phone") f.setPhone("+61499999888");
    if (kind === "patient") f.setCandidates({ kind: "one", candidateIds: ["43"] });
    if (kind === "disabled") f.setEnabled(false);
    if (kind === "policy") f.setVersion("changed");
    if (kind === "disconnect") f.authority.close();
    if (kind === "revokedAuthority") f.setPermitted(false);
    assert.equal((await f.authority.answer(f.mail[0]!.code)).ok, false);
  }
});

test("E2E-269 three wrong answers exhaust the call, and the shared budget gates issuing and every answer", async () => {
  const claims: string[] = [];
  const f = emailFixture({ budget: { reserve: async (_scope, kind) => { claims.push(kind); return true; } } });
  await f.authority.start("appointments.read"); await f.authority.start("appointments.read");
  const wrong = f.mail[0]!.code === "000000" ? "999999" : "000000";
  for (let i = 0; i < 3; i++) assert.equal((await f.authority.answer(wrong)).ok, false);
  assert.equal((await f.authority.answer(f.mail[0]!.code)).ok, false);
  assert.equal(f.mail.length, 1); assert.deepEqual(claims, ["issue", "answer", "answer", "answer"]);
  const denied = emailFixture({ budget: { reserve: async () => false } });
  await denied.authority.start("appointments.read"); assert.equal(denied.mail.length, 0); assert.equal(denied.reads.length, 0);
  const unavailable = emailFixture({ budget: { reserve: async () => { throw new Error("budget unavailable"); } } });
  await unavailable.authority.start("appointments.read"); assert.equal(unavailable.mail.length, 0);
});

test("E2E-269 token reuse across scope/call/session/patient/action/policy is denied and attestation is single-use", async () => {
  const f = emailFixture(); await f.authority.start("appointments.read");
  const token = await f.authority.answer(f.mail[0]!.code); assert.ok(token.ok);
  const request: PatientAuthorityRequest = { scope, callId: "otp-call", sessionId: "otp-session", candidateIds: ["42"],
    token: token.value, operation: "appointments.read", policyVersion: "policy", signal: new AbortController().signal };
  for (const changed of [{ ...request, scope: { ...scope, locationId: "other" } }, { ...request, callId: "other" },
    { ...request, sessionId: "other" }, { ...request, candidateIds: ["43"] }, { ...request, policyVersion: "changed" },
    { ...request, operation: "appointments.cancel" as const }]) assert.equal((await f.authority.attest(changed)).ok, false);
  assert.equal((await f.authority.attest(request)).ok, true); assert.equal((await f.authority.attest(request)).ok, false);
});

test("E2E-269 delivery loss, timeout and disconnect revoke the challenge and suppress late authority", async () => {
  for (const kind of ["failure", "throw", "timeout", "disconnect"] as const) {
    let code = "", release: (value: boolean) => void = () => undefined;
    const f = emailFixture({ deadlineMs: 20, delivery: async (_email, value) => {
      code = value;
      if (kind === "failure") return false;
      if (kind === "throw") throw new Error("delivery unavailable");
      return new Promise<boolean>(resolve => { release = resolve; });
    } });
    const started = f.authority.start("appointments.read");
    await new Promise<void>(resolve => setImmediate(resolve));
    if (kind === "disconnect") f.authority.close();
    await started; release(true); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await f.authority.answer(code)).ok, false);
  }
});

test("E2E-269 an expired or revoked token cannot attest after the caller supplied the correct code", async () => {
  for (const kind of ["expiry", "email", "disable", "revokedAuthority"] as const) {
    const f = emailFixture(); await f.authority.start("appointments.read");
    const token = await f.authority.answer(f.mail[0]!.code); assert.ok(token.ok);
    if (kind === "expiry") f.setTime(initial + 300_000);
    if (kind === "email") f.setEmail("changed@example.test");
    if (kind === "disable") f.setEnabled(false);
    if (kind === "revokedAuthority") f.setPermitted(false);
    assert.equal((await f.proof.issue(token.value, "appointments.read")).ok, false);
  }
});
