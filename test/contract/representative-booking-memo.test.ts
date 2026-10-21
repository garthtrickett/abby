import assert from "node:assert/strict";
import test from "node:test";
import { decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import type { AdministrativeMemoConfig } from "../../src/cliniko/administrative-memo-records.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { ClinikoRepresentativeCallOwner } from "../../src/standalone/cliniko-representative-call-owner.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { subjectMemoFixture } from "../support/subject-memo.ts";
import { representativeCallOwnerFixture } from "../support/representative-call-owner.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";

for (const mode of ["accepted", "wrongSubjectGrant", "withdrawn", "lostStored"] as const)
test(`actual representative booking keeps its patient distinct from the verified caller for ${mode} memo retention`, { timeout: 20000 }, async t => {
  const physical = new ClinikoReadBudget(180); let claims = 0;
  const budget = { claim: () => { claims++; return physical.claim(); }, observe429: physical.observe429.bind(physical) };
  const f = await representativeCallOwnerFixture({ budget }); f.flow.dispose();
  let owner: ClinikoRepresentativeCallOwner | undefined, ownedFlow: ClinikoCallFlow | undefined;
  const native: AdministrativeMemoConfig = { scope: f.f.scope, ...f.flowConfig.cliniko,
    authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) },
    clock: f.f.sessionConfig.clock, deadlineMs: 5000 };
  const memo = subjectMemoFixture(native, "43", { ...(mode === "wrongSubjectGrant" ? { approvedPatientId: "44" } : {}),
    ...(mode === "lostStored" ? { lostStored: true as const } : {}) });
  t.after(async () => { memo.close(); owner?.dispose(); ownedFlow?.dispose(); await f.close(); });
  const port: typeof fetch = async (url, init) => {
    const response = await f.flowConfig.fetchPort(url, init);
    if (mode === "withdrawn" && init?.method === "POST" && new URL(String(url)).pathname === "/v1/individual_appointments") memo.control.permitted = false;
    return response;
  };
  const flow = resultValue(ClinikoCallFlow.create({ ...f.flowConfig, fetchPort: port, memo: memo.config }));
  ownedFlow = flow;
  owner = resultValue(await ClinikoRepresentativeCallOwner.create({ ...f.config, flow }));
  assert.equal(owner.beginCallerVerification(), true); await f.waitForMail(1);
  assert.equal((await owner.submitCallerCode(f.mail[0]!.code)).verified, true);
  assert.deepEqual(resultValue(await owner.selectPatient(f.r.identity)), { codeRequired: true });
  flow.beginVerification(); await f.waitForMail(2);
  assert.equal(f.mail[1]!.email, "subject-one-private@example.test");
  assert.equal((await flow.submitCode(f.mail[1]!.code)).verified, true);
  const reception = new TextReception(f.f.ledger, f.f.policies, flow);
  const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.f.scope }, f.f.policies, reception, undefined, undefined, undefined, f.f.ledger);
  if ((await f.f.state()).pendingPresentationId) await f.play();
  resultValue(await agent.submit({ kind: "booking.offers.read.v1", turn: f.f.turn("menu"), from: "2026-10-08", to: "2026-10-08", now: verificationNow })); await f.play();
  resultValue(await agent.submit({ kind: "booking.offers.select.v1", turn: f.f.turn("select"), choice: 1, now: verificationNow }));
  const action = Object.values((await f.f.state()).actions)[0]!; assert.equal(f.writes, 0); assert.equal(memo.posts.length, 0);
  await f.play(); resultValue(await reception.affirm(f.f.scope, f.f.turn("affirm", "Yes"), action.key, action.digest, verificationNow));
  await reception.drain(f.f.scope, f.f.callId, verificationNow); await memo.memoSettled;
  assert.equal((await f.f.state()).actions[action.key]!.status, "committed"); assert.equal(f.writes, 1);
  const denied = mode === "wrongSubjectGrant" || mode === "withdrawn";
  assert.equal(memo.posts.length, denied ? 0 : 1); assert.equal(memo.rows.length, denied ? 0 : 1);
  assert.equal(memo.outcomes[0]!.kind, denied ? "unavailable" : mode === "lostStored" ? "uncertain" : "accepted");
  assert.ok(claims <= 180); if (!denied) assert.equal(memo.consumed.size, 1);
  if (!denied) { const body = memo.posts[0]!; const decoded = resultValue(decodeAdministrativeMemo(body.content));
    assert.equal(decoded.outcome.kind, "bookingConfirmed"); assert.notEqual(decoded.patientId, verificationCanaries[2]); }
  const publicData = JSON.stringify([await f.f.state(), await flow.publicIntentContext()]);
  for (const secret of [f.r.identity.firstName, f.r.identity.lastName, f.r.identity.dateOfBirth, ...f.mail.flatMap(row => [row.email, row.code]), ...memo.posts.map(row => String(row.content))])
    assert.equal(publicData.includes(secret), false);
  await reception.drain(f.f.scope, f.f.callId, verificationNow); assert.equal(f.writes, 1); assert.equal(memo.posts.length, denied ? 0 : 1);
});
