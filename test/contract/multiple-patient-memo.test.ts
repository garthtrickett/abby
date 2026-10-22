import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { commandProgress } from "../../src/reference/command-progress.ts";
import { representativeCallOwnerFixture } from "../support/representative-call-owner.ts";
import { representativeTaskSequenceFixture } from "../support/representative-task-sequence.ts";
import { subjectMemoFixture } from "../support/subject-memo.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

for (const mode of ["accepted", "firstDenied", "secondDenied", "lostStored", "firstClinicalUncertain", "pendingPrior"] as const)
test(`independent patient task memos retain the original subject and source: ${mode}`, { timeout: 120000 }, async t => {
  const physical = new ClinikoReadBudget(180); let claims = 0, deniedClaims = 0;
  const budget = { claim: () => { claims++; const result = physical.claim(); if (result) deniedClaims++; return result; }, observe429: physical.observe429.bind(physical) };
  const caller = await representativeCallOwnerFixture({ multiplePatients: true, budget });
  const began = performance.now();
  const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - began).toISOString(); caller.f.setTime(now); return now; };
  const memo = subjectMemoFixture({ scope: caller.f.scope, ...caller.flowConfig.cliniko,
    authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) }, clock, deadlineMs: 5000 }, ["43", "44"], {
    ...(mode === "firstDenied" ? { approvedPatientId: "44" } : mode === "secondDenied" ? { approvedPatientId: "43" } : {}),
    ...(mode === "lostStored" ? { lostStored: true } : {}) });
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const config = mode === "pendingPrior" ? { ...memo.config, fetchPort: async (...args: Parameters<typeof fetch>) => {
    entered = true; await gate; return memo.config.fetchPort!(...args);
  } } : memo.config;
  const f = await representativeTaskSequenceFixture("independentlyVerifiedPatients", { caller, memo: config, clock });
  t.after(async () => { release(); memo.close(); await f.closeSequence(); });
  const waitFor = async (check: () => boolean, label: string) => {
    const deadline = Date.now() + 5000;
    while (!check() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.ok(check(), label);
  };
  const settle = async (count: number) => {
    await waitFor(() => memo.outcomes.length >= count, "independent memo completion");
    assert.equal(memo.outcomes.length, count);
  };
  const pause = async () => {
    // Real caller pacing ages the shared account window. Keep the ordinary
    // lease and fresh proof for the next independently approved patient task.
    for (const delay of [15000, 15000, 15000, 16000]) {
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      const lease = (await f.f.state()).sessionLease!; assert.ok(lease);
      resultValue(await f.f.runtime.renewSession(f.f.callId, f.f.sessionId, lease.version, clock()));
    }
  };
  const source = (index: number) => {
    const marker = /^Abby booking ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(String(f.native.requests[index]!.notes))?.[1];
    assert.ok(marker); return marker;
  };
  const firstOwner = await f.verify("43");
  if (mode === "firstClinicalUncertain") f.native.loseResponse();
  const first = await f.book(), firstSnapshot = structuredClone(first), firstSource = source(0);
  assert.equal(f.native.requests.length, 1); assert.equal(f.native.requests[0]!.patient_id, "43");
  if (mode === "firstClinicalUncertain") {
    assert.ok(["uncertain", "needsReview"].includes(first.status));
    assert.equal(await f.flow.representativeStartupAvailable("book"), false);
    const state = await f.f.state();
    assert.equal((await f.flow.startWorkflow({ scope: f.f.scope, callId: f.f.callId, sessionId: f.f.sessionId,
      policyVersion: f.flowConfig.policyVersion, operation: "book", forAnotherPerson: true,
      expectedConversationRevision: state.conversationRevision, signal: new AbortController().signal })).ok, false);
    assert.equal(f.flow.representativeInputOwner, firstOwner); assert.equal(f.mail.length, 2);
    assert.equal(memo.posts.length, 0); assert.equal(memo.consumed.size, 0); assert.equal(memo.outcomes.length, 0);
  } else if (mode === "pendingPrior") {
    assert.equal(first.status, "committed"); await waitFor(() => entered, "first pending memo native dispatch");
    assert.equal(memo.rows.length, 0); assert.equal(memo.consumed.size, 1);
    const secondOwner = await f.start(); assert.notEqual(secondOwner, firstOwner); assert.equal(firstOwner.closed, true);
    release(); await settle(1);
    const retained = resultValue(decodeAdministrativeMemo(memo.posts[0]!.content));
    assert.equal(retained.patientId, "43"); assert.equal(retained.sourceActionRef, firstSource);
    assert.equal(memo.outcomes[0]!.kind, "accepted"); assert.equal(f.native.requests.length, 1);
    assert.equal(f.mail.length, 2); assert.deepEqual((await f.f.state()).actions[first.key], firstSnapshot);
  } else {
    assert.equal(first.status, "committed"); await settle(1); await pause();
    const secondOwner = await f.verify("44"); assert.notEqual(secondOwner, firstOwner); assert.equal(firstOwner.closed, true);
    assert.equal(f.mail.length, 4); assert.notEqual(f.mail[1]!.email, f.mail[3]!.email);
    const second = await f.book(); assert.equal(second.status, "committed", JSON.stringify({ claims, deniedClaims }));
    await settle(2); const secondSource = source(1); assert.notEqual(firstSource, secondSource);
    assert.deepEqual(f.native.requests.map(row => row.patient_id), ["43", "44"]);
    assert.deepEqual((await f.f.state()).actions[first.key], firstSnapshot);
    const expected = mode === "firstDenied" ? ["44"] : mode === "secondDenied" ? ["43"] : ["43", "44"];
    const retained = memo.posts.map(row => resultValue(decodeAdministrativeMemo(row.content)));
    assert.deepEqual(retained.map(row => row.patientId), expected);
    assert.deepEqual(memo.outcomes.map(row => row.kind), mode === "firstDenied" ? ["unavailable", "accepted"]
      : mode === "secondDenied" ? ["accepted", "unavailable"] : mode === "lostStored" ? ["uncertain", "uncertain"] : ["accepted", "accepted"]);
    assert.equal(memo.consumed.size, expected.length);
    assert.equal(new Set(memo.rows.map(row => row.id)).size, expected.length);
    for (const row of retained) {
      assert.equal(row.sourceActionRef, row.patientId === "43" ? firstSource : secondSource);
      assert.equal(row.direction, "inbound"); assert.equal(row.outcome.kind, "bookingConfirmed");
      assert.deepEqual(resultValue(await memo.config.barrier.claimOnce(row.actionRef)), { claimed: false });
    }
    await f.reception.drain(f.f.scope, f.f.callId, clock());
    assert.equal(f.native.requests.length, 2); assert.equal(memo.posts.length, expected.length);
  }
  const state = await f.f.state();
  const publicData = JSON.stringify([commandProgress(state, "multiple-patient-memo"), state.callerMessages, await f.flow.publicIntentContext()]);
  const secrets = [...f.r.patients.values()].flatMap(row => [row.first_name, row.last_name, row.date_of_birth, row.email])
    .concat(f.mail.flatMap(row => [row.email, row.code]), memo.posts.map(row => String(row.content)),
      f.native.requests.flatMap((row, index) => [String(row.notes), source(index)]), [memo.key.toString("hex"), memo.key.toString("base64")]);
  for (const [index, value] of secrets.entries()) assert.equal(publicData.includes(value), false, `private canary index ${index}`);
  assert.equal(deniedClaims, 0, `shared rolling180 physical claims: ${claims}`);
});
