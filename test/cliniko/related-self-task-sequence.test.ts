// E2E-387: explicit native caller task after an independently approved related-person task.
import assert from "node:assert/strict";
import test from "node:test";
import { callerRequestLanguage } from "../../src/standalone/representative-request-language.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { relatedSelfTaskSequenceFixture as fixture } from "../support/related-self-task-sequence.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("explicit caller-subject language is bounded and cannot infer identity from mixed or negative requests", () => {
  for (const [text, operation] of [["Book an appointment for myself", "book"], ["Please book another appointment for me.", "book"],
    ["Cancel my appointment for myself", "cancel"], ["Reschedule my appointment for me", "reschedule"],
    ["Check my appointments for myself", "appointments.read"]] as const) assert.equal(callerRequestLanguage(text), operation);
  for (const text of ["Book another appointment", "Book for my daughter", "Book an appointment for myself and my daughter",
    "Don't book an appointment for me", "Someone told me to book an appointment for myself", "Book an appointment for my wife",
    "Book an appointment for myself at 2pm", "x".repeat(4001)]) assert.equal(callerRequestLanguage(text), undefined);
});

test("a settled related booking can explicitly return to the pinned native caller with fresh proof and separate consent", async () => {
  const f = await fixture();
  try {
    const owner = await f.startRelated(), first = await f.book(); assert.equal(first.status, "committed");
    const receipt = structuredClone(first); await f.nextWindow();
    const intent = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04",
      fetch: async () => { throw Error("explicit caller selection cannot require a model"); } });
    assert.deepEqual(resultValue(await intent(f.turn("Book an appointment for myself"))), { kind: "workflow", operation: "book", forCaller: true });
    resultValue(await f.startSelf()); await f.play(); await f.base.waitForMail(3);
    assert.equal(owner.closed, true); assert.equal(f.flow.representativeInputOwner, undefined); assert.equal(f.flow.verificationRequired, true);
    assert.equal(f.base.mail[2]!.email, verificationCanaries[0]); assert.equal(f.native.requests.length, 1);
    assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, false);
    assert.equal((await f.flow.publicIntentContext())?.lastAction, null);
    if (first.mutation.request.kind !== "book") throw Error("wrong operation");
    assert.equal((await f.flow.resolveBooking(f.base.f.scope, first.mutation.request.patient.verificationRef,
      first.mutation.request.offer.offerRef, f.now())).ok, false);
    assert.equal((await f.flow.submitCode(f.base.mail[2]!.code)).verified, true);
    const second = await f.book(); assert.equal(second.status, "committed");
    assert.deepEqual(f.native.requests.map(row => row.patient_id), [f.base.r.subjectIds[0], verificationCanaries[2]]);
    assert.notEqual(first.key, second.key); assert.notEqual(first.hostRef, second.hostRef);
    assert.deepEqual((await f.base.f.state()).actions[first.key], receipt);
    assert.deepEqual(await f.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
    assert.deepEqual(await f.flow.write(first.mutation, f.now()), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
    assert.equal((await f.flow.startWorkflow({ ...f.query(), forCaller: true, expectedConversationRevision: (await f.base.f.state()).conversationRevision })).ok, false);
    assert.equal(f.base.mail.length, 3); assert.equal(f.native.requests.length, 2);
    const publicData = JSON.stringify([await f.base.f.state(), await f.flow.publicIntentContext()]);
    for (const value of [f.base.r.identity.firstName, f.base.r.identity.lastName, ...f.base.mail.flatMap(row => [row.code, row.email])])
      assert.equal(publicData.includes(value), false);
  } finally { await f.close(); }
});

test("a caller booking followed by a related-patient booking requires new actor and subject proofs and separate receipts", async () => {
  const f = await fixture();
  try {
    await f.verifySelf(false); const first = await f.book(); assert.equal(first.status, "committed"); await f.nextWindow();
    const owner = await f.prepareRelated(); assert.equal(owner.closed, false);
    assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, false, "the prior native proof cannot activate an unchallenged related workflow");
    assert.equal(owner.beginCallerVerification(), true); await f.base.waitForMail(2);
    assert.equal((await owner.submitCallerCode(f.base.mail[1]!.code)).verified, true);
    resultValue(await owner.selectPatient(f.base.r.identity)); assert.equal(owner.beginPatientVerification(), true); await f.base.waitForMail(3);
    assert.equal((await f.flow.submitCode(f.base.mail[2]!.code)).verified, true);
    assert.equal(f.native.requests.length, 1);
    if (first.mutation.request.kind !== "book") throw Error("wrong original operation");
    assert.equal((await f.flow.resolveBooking(f.base.f.scope, first.mutation.request.patient.verificationRef,
      first.mutation.request.offer.offerRef, f.now())).ok, false);
    const second = await f.book(); assert.equal(second.status, "committed");
    assert.deepEqual(f.native.requests.map(row => row.patient_id), [verificationCanaries[2], f.base.r.subjectIds[0]]);
    assert.notEqual(first.key, second.key); assert.notEqual(first.hostRef, second.hostRef);
    assert.deepEqual((await f.base.f.state()).actions[first.key], first);
    assert.deepEqual(await f.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
    assert.deepEqual(await f.flow.write(first.mutation, f.now()), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
  } finally { await f.close(); }
});

test("an ordinary next-task request cannot silently leave a related subject", async () => {
  const f = await fixture();
  try {
    const owner = await f.startRelated(), first = await f.book(); assert.equal(first.status, "committed"); await f.nextWindow();
    assert.equal((await f.flow.startWorkflow({ ...f.query(), expectedConversationRevision: (await f.base.f.state()).conversationRevision })).ok, false);
    const intent = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04",
      fetch: async () => Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
        text: JSON.stringify({ kind: "workflow", operation: "book", stage: null, from: null, to: null, choice: null, forCaller: true }) }] }] }) });
    assert.deepEqual(await intent(f.turn("Please help with something else")), { ok: false, error: { kind: "intentUnavailable" } },
      "a model cannot supply the trusted caller-subject marker");
    assert.equal(f.flow.representativeInputOwner, owner); assert.equal(owner.closed, false);
    assert.equal(f.base.mail.length, 2); assert.equal(f.native.requests.length, 1); assert.deepEqual((await f.base.f.state()).actions[first.key], first);
  } finally { await f.close(); }
});

test("an unresolved related booking blocks explicit caller advancement without replay", async () => {
  const f = await fixture();
  try {
    const owner = await f.startRelated(); f.native.loseResponse(); const first = await f.book();
    assert.ok(["uncertain", "needsReview"].includes(first.status));
    assert.equal((await f.flow.startWorkflow({ ...f.query(), forCaller: true, expectedConversationRevision: (await f.base.f.state()).conversationRevision })).ok, false);
    assert.equal(f.flow.representativeInputOwner, owner); assert.equal(f.base.mail.length, 2); assert.equal(f.native.requests.length, 1);
    assert.deepEqual((await f.base.f.state()).actions[first.key], first);
  } finally { await f.close(); }
});

for (const fault of ["taskApproval", "membership", "candidate", "permission"] as const) {
  test(`returning to the caller independently enforces current ${fault}`, async () => {
    const f = await fixture();
    try {
      const owner = await f.startRelated(), first = await f.book(); assert.equal(first.status, "committed"); await f.nextWindow();
      if (fault === "taskApproval" || fault === "membership") {
        if (fault === "taskApproval") await f.source.replace({ enabled: false });
        else await f.base.f.replaceAccount({ ...f.base.f.account, membershipVersion: "withdrawn" });
        assert.equal((await f.flow.startWorkflow({ ...f.query(), forCaller: true, expectedConversationRevision: (await f.base.f.state()).conversationRevision })).ok, false);
        assert.equal(owner.closed, false); assert.equal(f.base.mail.length, 2);
      } else {
        resultValue(await f.startSelf()); await f.play(); await f.base.waitForMail(3);
        if (fault === "candidate") f.base.f.setCandidates({ kind: "one", candidateIds: ["99"] }); else f.denySelf();
        assert.equal((await f.flow.submitCode(f.base.mail[2]!.code)).verified, false);
        assert.equal(owner.closed, true); assert.equal(f.flow.verificationRequired, true);
      }
      assert.equal(f.native.requests.length, 1); assert.deepEqual((await f.base.f.state()).actions[first.key], first);
    } finally { await f.close(); }
  });
}

test("aborting caller preparation preserves the related owner and permits a fresh explicit request", async () => {
  const f = await fixture();
  try {
    const owner = await f.startRelated(), first = await f.book(); assert.equal(first.status, "committed"); await f.nextWindow();
    const original = f.flow.startWorkflow.bind(f.flow), stop = new AbortController();
    f.flow.startWorkflow = async query => { const result = await original(query); assert.equal(result.ok, true); stop.abort(); return result; };
    assert.equal((await f.startSelf(true, stop.signal)).ok, false);
    assert.equal(owner.closed, false); assert.equal(f.flow.representativeInputOwner, owner); assert.equal(f.base.mail.length, 2);
    assert.equal((await f.base.f.state()).previousTaskActionKeys, undefined);
    f.flow.startWorkflow = original; await f.verifySelf(); assert.equal((await f.book()).status, "committed");
    assert.deepEqual((await f.base.f.state()).actions[first.key], first); assert.equal(f.native.requests.length, 2);
  } finally { await f.close(); }
});

test("a committed caller task with failed activation retires related authority and needs a fresh native challenge", async () => {
  const f = await fixture();
  try {
    const owner = await f.startRelated(), first = await f.book(); assert.equal(first.status, "committed"); await f.nextWindow();
    const complete = f.flow.completeWorkflowStart.bind(f.flow); f.flow.completeWorkflowStart = async () => false;
    assert.equal((await f.startSelf()).ok, false); await f.play();
    assert.equal(owner.closed, true); assert.equal(f.flow.representativeInputOwner, undefined); assert.equal(f.base.mail.length, 2);
    assert.deepEqual((await f.base.f.state()).previousTaskActionKeys, [first.key]);
    assert.deepEqual((await f.base.f.state()).actions[first.key], first);
    f.flow.completeWorkflowStart = complete; await f.verifySelf(false); assert.equal((await f.book()).status, "committed");
    assert.equal(f.base.mail.length, 3); assert.equal(f.native.requests.length, 2);
  } finally { await f.close(); }
});

test("an abort during final caller-task approval cannot activate or issue a challenge", async t => {
  const f = await fixture();
  try {
    const owner = await f.startRelated(), first = await f.book(); assert.equal(first.status, "committed"); await f.nextWindow();
    const stop = new AbortController(), complete = f.flow.completeWorkflowStart.bind(f.flow);
    let activating = false, approvalAbort = false;
    t.mock.method(f.flow, "completeWorkflowStart", async (...args: Parameters<typeof complete>) => {
      activating = true; try { return await complete(...args); } finally { activating = false; }
    });
    const find = f.base.f.directory.findByRef.bind(f.base.f.directory);
    t.mock.method(f.base.f.directory, "findByRef", async (...args: Parameters<typeof find>) => {
      const result = await find(...args);
      if (activating) { approvalAbort = true; stop.abort(); }
      return result;
    });
    assert.equal((await f.startSelf(true, stop.signal)).ok, false);
    assert.equal(approvalAbort, true); assert.equal(owner.closed, true); assert.equal(f.flow.representativeInputOwner, undefined);
    assert.equal(f.base.mail.length, 2, "a cancelled activation must not begin native caller verification");
    assert.equal(f.native.requests.length, 1); assert.deepEqual((await f.base.f.state()).actions[first.key], first);
  } finally { await f.close(); }
});

test("caller markers cannot mix subjects or extend a related task to other workflow families", async () => {
  const f = await fixture();
  try {
    const owner = await f.startRelated(), first = await f.book(); assert.equal(first.status, "committed"); await f.nextWindow();
    const query = { ...f.query(), forCaller: true as const, expectedConversationRevision: (await f.base.f.state()).conversationRevision };
    for (const extra of [{ forAnotherPerson: true as const }, { classAttendance: true as const }, { operation: "intake" as const },
      { operation: "patientUpdate" as const }, { operation: "confirmationResend" as const }, { replaceCanceledChange: true as const }])
      assert.equal((await f.flow.startWorkflow({ ...query, ...extra })).ok, false);
    assert.equal(owner.closed, false); assert.equal(f.base.mail.length, 2); assert.equal(f.native.requests.length, 1);
    assert.deepEqual((await f.base.f.state()).actions[first.key], first);
  } finally { await f.close(); }
});

test("a separate non-patient guardian record cannot become a native caller-patient task", async () => {
  const f = await fixture({ guardian: true });
  try {
    const owner = await f.startRelated(), first = await f.book(); assert.equal(first.status, "committed"); await f.nextWindow();
    const reads = f.guardian!.reads.length;
    assert.equal((await f.flow.startWorkflow({ ...f.query(), forCaller: true, expectedConversationRevision: (await f.base.f.state()).conversationRevision })).ok, false);
    assert.equal(f.guardian!.reads.length, reads); assert.equal(owner.closed, false);
    assert.equal(f.base.mail.length, 2); assert.equal(f.native.requests.length, 1); assert.deepEqual((await f.base.f.state()).actions[first.key], first);
  } finally { await f.close(); }
});

test("explicit self language also preserves ordinary same-caller task progression", async () => {
  const f = await fixture();
  try {
    await f.source.replace({ patientSelection: "sameVerifiedCaller" });
    await f.verifySelf(false); const first = await f.book(); assert.equal(first.status, "committed"); await f.nextWindow();
    await f.verifySelf(); const second = await f.book(); assert.equal(second.status, "committed");
    assert.deepEqual(f.native.requests.map(row => row.patient_id), [verificationCanaries[2], verificationCanaries[2]]);
    assert.equal(f.base.mail.length, 2); assert.deepEqual((await f.base.f.state()).actions[first.key], first);
  } finally { await f.close(); }
});
