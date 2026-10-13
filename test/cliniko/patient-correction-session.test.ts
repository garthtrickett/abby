import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { ClinikoPatientCorrectionSession } from "../../src/standalone/cliniko-patient-correction-session.ts";
import type { PatientCorrectionSessionConfig } from "../../src/standalone/cliniko-patient-correction-session.ts";
import { ClinikoReviewedSend } from "../../src/standalone/cliniko-reviewed-send.ts";
import { OwnerFilePatientUpdatePolicy, patientUpdateScopeText } from "../../src/standalone/owner-file-patient-update-policy.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { PatientUpdateApproval } from "../../src/standalone/owner-file-patient-update-policy.ts";
import { callerVerificationFixture, verificationNow, verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

async function fixture() {
  const f = await callerVerificationFixture({ operation: "patients.update", patientUpdateExecute: true });
  const apiKey = "synthetic-session-au5", base = "https://api.au5.cliniko.com/v1", patientId = verificationCanaries[2]!;
  const path = join(f.folder, "correction.json");
  const approval: PatientUpdateApproval = { scope: f.scope, revision: "correction-1", approverRef: f.account.actor.actorRef, approved: true, enabled: true,
    approvedAt: "2026-01-01T00:00:00.000Z", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2027-01-01T00:00:00.000Z",
    policyVersion: f.config.policyVersion, correctionVersion: "1", businessId: "11", credentialFingerprint: clinikoCredentialFingerprint(apiKey), timeZone: "Australia/Sydney",
    operation: "patients.update", recordScope: "clinikoAccount", callerEligibility: "selfOnly", minors: "deny", representatives: "deny", minimumAgeYears: 18,
    leapDayBirthday: "march1", patientPermission: "independentClinicHost", verificationMethod: "registeredEmailOtp", emailChangeVerification: "prospectiveEmailOtp",
    confirmation: "privateReadback", contactSynchronization: "revokeProofsAndInvalidateAccountLookups", allowedFields: ["email", "post_code"],
    privacyTerms: { version: "privacy-1", approvedText: "Your details are held in Cliniko." }, correctionTerms: { version: "correction-1", approvedText: patientUpdateScopeText } };
  let session: ClinikoPatientCorrectionSession | undefined;
  try {
    await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
    const policy = resultValue(await OwnerFilePatientUpdatePolicy.capture({ ...approval, path, directory: f.config.directory, correctionsEnabled: true, clock: f.config.clock }));
    let row: Record<string, unknown> = { id: patientId, archived_at: null, merged_at: null, updated_at: verificationNow, links: { self: `${base}/patients/${patientId}` },
      first_name: "Synthetic", last_name: "Patient", date_of_birth: "1980-01-02", email: verificationCanaries[0], patient_phone_numbers: [{ number: "+61400111222", phone_type: "Mobile" }],
      address_1: "1 Example Road", address_2: null, address_3: null, city: "Example", state: "VIC", post_code: "3000", country_code: "AU", notes: "private-chart-canary" };
    let mode = "", synced = 0, playback = true;
    let onRecall = async () => {}, onPatch = async () => {};
    const traffic: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [], played: string[] = [], mail: Array<{ email: string; code: string }> = [];
    const fetchPort: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname, method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined; traffic.push({ method, path, ...(body ? { body } : {}) });
      assert.equal(new URL(String(url)).origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
      if (path === "/v1/recalls") {
        assert.equal(method, "POST"); const parsed = decodeClinikoReview(body.notes); assert.ok(parsed.ok); assert.equal(parsed.value.request.operation.kind, "patientUpdate");
        await onRecall(); if (mode === "lostReview") throw new Error("lost");
        return Response.json({ id: "91", notes: body.notes, recalled: false, archived_at: null, recall_at: body.recall_at,
          patient: { links: { self: `${base}/patients/${patientId}` } }, recall_type: { links: { self: `${base}/recall_types/7` } } }, { status: 201 });
      }
      assert.equal(path, `/v1/patients/${patientId}`);
      if (method === "PATCH") {
        assert.ok(traffic.some(t => t.path === "/v1/recalls")); row = { ...row, ...body, updated_at: "2026-10-04T06:00:01.000Z" };
        if (typeof body.email === "string") f.setEmail(body.email);
        await onPatch(); if (mode === "lostPatch") throw new Error("lost");
      } else assert.equal(method, "GET");
      return Response.json(row);
    };
    const rateBudget = { claim: async () => null, observe429: async () => ({ kind: "rateLimited" as const }) };
    const writer = resultValue(ClinikoRecallWriter.create({ scope: f.scope, apiKey, contactEmail: "test@example.test", rateBudget }, fetchPort));
    const reviewed = new ClinikoReviewedSend({ scope: f.scope, businessId: "11", credentialFingerprint: approval.credentialFingerprint,
      policyVersion: f.config.policyVersion, timeZone: approval.timeZone, recallTypeId: "7", writer, clock: () => Date.parse(f.config.clock()) });
    const config: PatientCorrectionSessionConfig = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId,
      policyVersion: f.config.policyVersion, ledger: f.ledger, policies: f.policies, policy, verification: f.session, permission: f.sessionConfig.permission,
      verificationBudget: { reserve: async () => true }, delivery: { send: async (email, code) => { mail.push({ email, code }); return mode !== "lostCode"; } },
      presentation: { play: async text => { played.push(text); return playback; } }, reviewedSend: reviewed,
      synchronize: async () => { synced++; return mode !== "failedSync"; }, cliniko: { apiKey, contactEmail: "test@example.test", rateBudget },
      signal: new AbortController().signal, fetchPort, clock: f.config.clock };
    session = resultValue(await ClinikoPatientCorrectionSession.create(config));
    const owner = session, worker = new EffectWorker(f.runtime, owner, undefined, undefined, { clock: f.config.clock });
    const gateway = new CommandGateway({ actorRef: "synthetic-agent", role: "agent", scope: f.scope }, f.policies,
      new TextReception(f.ledger, f.policies, owner, undefined, undefined, undefined, undefined, f.config.clock));
    f.session.begin(); assert.deepEqual(await f.session.submitCode(""), { verified: false });
    assert.deepEqual(await f.session.submitCode(f.mail[0]!.code), { verified: true });
    const terms = resultValue(await owner.begin()); assert.equal(await owner.acknowledge(terms.consentRef, true), true);
    const collect = () => owner.collect({ email: "new@example.test", post_code: "3001" });
    const resolve = (ref: string) => owner.resolvePatientCorrection({ scope: f.scope, callId: f.callId, sessionId: f.sessionId,
      policyVersion: f.config.policyVersion, correctionRef: ref, now: f.config.clock() });
    const propose = async (ref: string) => {
      const response = resultValue(await gateway.submit({ kind: "patients.correction.propose.v1", correctionRef: ref, now: f.config.clock(),
        turn: { callId: f.callId, sessionId: f.sessionId, turnId: crypto.randomUUID(), text: "Save the correction", quality: "clear", at: f.config.clock() } }));
      assert.equal(response.kind, "patientCorrectionProposal");
      const state = await f.state(), pending = Object.values(state.actions).find(a => a.status === "awaitingConfirmation")!; assert.ok(pending); return pending;
    };
    const confirm = async (action: Awaited<ReturnType<typeof propose>>) => {
      resultValue(await f.runtime.startPresentation(f.callId, action.presentationId, f.sessionId, f.config.clock()));
      resultValue(await f.runtime.resolvePresentation(f.callId, action.presentationId, "played", f.sessionId, f.config.clock()));
      resultValue(await f.runtime.acceptTurn({ callId: f.callId, sessionId: f.sessionId, turnId: crypto.randomUUID(), text: "Yes", quality: "clear", at: f.config.clock() },
        { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, f.config.clock()));
    };
    return { f, config, approval, path, owner, gateway, traffic, played, mail, collect, resolve, propose, confirm, worker, get row() { return row; }, get synced() { return synced; },
      mode(value: string) { mode = value; }, playback(value: boolean) { playback = value; }, onRecall(fn: typeof onRecall) { onRecall = fn; }, onPatch(fn: typeof onPatch) { onPatch = fn; },
      close: async () => { owner.dispose(); reviewed.close(); await f.close(); } };
  } catch (error) { session?.dispose(); await f.close(); throw error; }
}

test("E2E-362 private correction crosses real verification, SAM, native review and one inspected PATCH after contact changes", async () => {
  const f = await fixture();
  try {
    const collected = resultValue(await f.collect()); assert.equal(collected.codeRequired, true);
    assert.equal((await f.resolve(collected.correctionRef)).ok, false);
    assert.deepEqual(await f.owner.answer(f.mail[0]!.code), { verified: true });
    const action = await f.propose(collected.correctionRef);
    assert.equal((await f.owner.write(action.mutation, verificationNow)).kind, "rejected"); assert.equal(f.traffic.some(t => t.method === "PATCH"), false);
    await f.confirm(action); await f.worker.process(f.f.callId, `${action.key}:write`, verificationNow);
    assert.equal((await f.f.state()).actions[action.key]?.status, "committed"); assert.equal(f.synced, 1);
    assert.equal(f.traffic.filter(t => t.method === "PATCH").length, 1); assert.equal(f.traffic.filter(t => t.path === "/v1/recalls").length, 1);
    assert.deepEqual(f.traffic.find(t => t.method === "PATCH")!.body, { email: "new@example.test", post_code: "3001" });
    assert.equal(f.row.notes, "private-chart-canary"); assert.equal(await f.f.session.verified(), undefined);
    const shared = JSON.stringify(await f.f.state()); for (const canary of ["new@example.test", "private-chart-canary", "1980-01-02", "1 Example Road"]) assert.equal(shared.includes(canary), false);
    assert.equal(JSON.stringify(f.traffic.find(t => t.path === "/v1/recalls")!.body).includes("new@example.test"), false);
    assert.ok(f.played.some(text => text.includes("new@example.test"))); // private transport only
    assert.equal((await f.owner.write(action.mutation, verificationNow)).kind, "rejected");
  } finally { await f.close(); }
});

for (const mode of ["lostPatch", "failedSync", "lostReview"] as const) {
  test(`E2E-362 ${mode} correction remains uncertain without replay or false registration success`, async () => {
    const f = await fixture();
    try {
      const collected = resultValue(await f.collect()); assert.equal((await f.owner.answer(f.mail[0]!.code)).verified, true);
      const action = await f.propose(collected.correctionRef); await f.confirm(action); f.mode(mode);
      await f.worker.process(f.f.callId, `${action.key}:write`, verificationNow);
      assert.equal((await f.f.state()).actions[action.key]?.status, "uncertain");
      assert.equal(f.traffic.filter(t => t.method === "PATCH").length, mode === "lostReview" ? 0 : 1);
      assert.equal((await f.owner.write(action.mutation, verificationNow)).kind, "rejected");
      assert.equal((await f.f.state()).callerMessages.some(text => text.includes("Your details were saved")), false);
    } finally { await f.close(); }
  });
}

test("E2E-362 recollection destroys old correction/code references and unplayed private readback cannot prepare", async () => {
  const f = await fixture();
  try {
    const first = resultValue(await f.collect()); const oldCode = f.mail[0]!.code;
    const second = resultValue(await f.owner.collect({ post_code: "3002" })); assert.equal(second.codeRequired, false);
    assert.equal((await f.resolve(first.correctionRef)).ok, false); assert.equal((await f.owner.answer(oldCode)).verified, false);
    assert.equal((await f.resolve(second.correctionRef)).ok, true);
    f.playback(false); assert.equal((await f.owner.collect({ post_code: "3003" })).ok, false);
    assert.equal((await f.resolve(second.correctionRef)).ok, false); assert.equal(f.traffic.some(t => t.method === "PATCH"), false);
  } finally { await f.close(); }
});

test("E2E-362 permission withdrawn after saved review prevents PATCH; withdrawal after PATCH suppresses success", async () => {
  for (const stage of ["before", "after"] as const) {
    const f = await fixture();
    try {
      const collected = resultValue(await f.collect()); assert.equal((await f.owner.answer(f.mail[0]!.code)).verified, true);
      const action = await f.propose(collected.correctionRef); await f.confirm(action);
      if (stage === "before") f.onRecall(async () => { f.f.setPermitted(false); });
      else f.onPatch(async () => { f.f.setPermitted(false); });
      await f.worker.process(f.f.callId, `${action.key}:write`, verificationNow);
      assert.equal(f.traffic.filter(t => t.method === "PATCH").length, stage === "before" ? 0 : 1);
      assert.equal((await f.f.state()).actions[action.key]?.status, stage === "before" ? "rejected" : "uncertain");
    } finally { await f.close(); }
  }
});

test("E2E-362 failed prospective delivery grants no correction; public commands accept references only", async () => {
  const f = await fixture();
  try {
    f.mode("lostCode"); const collected = resultValue(await f.collect());
    assert.equal((await f.owner.answer(f.mail[0]!.code)).verified, false); assert.equal((await f.resolve(collected.correctionRef)).ok, false);
    const command = { kind: "patients.correction.propose.v1" as const, correctionRef: collected.correctionRef, now: verificationNow,
      turn: { callId: f.f.callId, sessionId: f.f.sessionId, turnId: crypto.randomUUID(), text: "Save correction", quality: "clear" as const, at: verificationNow } };
    assert.equal((await f.gateway.submit({ ...command, email: "new@example.test" } as typeof command)).ok, false);
    assert.equal(f.traffic.some(t => t.method === "PATCH"), false);
  } finally { await f.close(); }
});

test("E2E-362 caller verification from another Cliniko credential cannot bind a correction even at the same scope", async () => {
  const f = await fixture();
  try {
    const apiKey = "different-synthetic-account-au5", credentialFingerprint = clinikoCredentialFingerprint(apiKey);
    assert.equal(f.f.session.matchesClinikoAccount(f.approval.credentialFingerprint), true);
    assert.equal(f.f.session.matchesClinikoAccount(credentialFingerprint), false);
    await writeFile(f.path, JSON.stringify({ ...f.approval, credentialFingerprint }));
    const policy = resultValue(await OwnerFilePatientUpdatePolicy.capture({ ...f.approval, credentialFingerprint, path: f.path,
      directory: f.f.config.directory, correctionsEnabled: true, clock: f.f.config.clock }));
    const result = await ClinikoPatientCorrectionSession.create({ ...f.config, policy, cliniko: { ...f.config.cliniko, apiKey } });
    assert.equal(result.ok, false); assert.equal(f.traffic.length, 0);
  } finally { await f.close(); }
});

test("E2E-363 disable and re-enable correction setting cannot revive captured consent or a ready native write", async () => {
  const f = await fixture();
  try {
    const collected = resultValue(await f.collect()); assert.equal((await f.owner.answer(f.mail[0]!.code)).verified, true);
    const action = await f.propose(collected.correctionRef); await f.confirm(action);
    assert.equal((await f.f.policies.changePatientCorrectionsEnabled(f.f.scope, "1", false, "owner")).ok, true);
    assert.equal((await f.f.policies.changePatientCorrectionsEnabled(f.f.scope, "2", true, "owner")).ok, true);
    await f.worker.process(f.f.callId, `${action.key}:write`, verificationNow);
    assert.equal((await f.f.state()).actions[action.key]?.status, "rejected"); assert.equal(f.traffic.some(t => t.method === "PATCH"), false);
    assert.equal(f.traffic.some(t => t.path === "/v1/recalls"), false);
  } finally { await f.close(); }
});
