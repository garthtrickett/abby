import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { classCallFlowFixture } from "../support/class-call-flow.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { ok } from "../../src/core/model.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";

type Fixture = Awaited<ReturnType<typeof classCallFlowFixture>>;
const resolver = (f: Fixture) => createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
  fetch: async () => { throw new Error("approved class selection must not invoke a public model"); } });
async function question(f: Fixture, operation: "book" | "cancel", played = true) {
  const turn = f.turn("service", `${operation} my Pilates class`), intent = resultValue(await resolver(f)(turn));
  assert.equal(intent.kind, "classServiceQuestion");
  if (intent.kind !== "classServiceQuestion") throw new Error("missing class services");
  assert.equal(intent.question.labels.length, 2);
  assert.match(intent.question.labels[0]!, /Mat Pilates.*Demo Instructor.*60 minutes/);
  assert.match(intent.question.labels[1]!, /Reformer Pilates.*Second Instructor.*30 minutes/);
  resultValue(await f.runtime.acceptTurn(turn, intent, verificationNow));
  if (played) await f.play();
  return intent;
}
async function selected(f: Fixture) {
  const turn = f.turn("selected", "The second class please"), intent = resultValue(await resolver(f)(turn));
  assert.equal(intent.kind, "workflow");
  if (intent.kind !== "workflow") throw new Error("missing class selection");
  assert.ok(intent.classSelectionRef); assert.equal(intent.classAttendance, true);
  return { turn, intent };
}
for (const operation of ["book", "cancel"] as const)
  test(`E2E-396 played class choice binds ${operation} to the second instructor and duration through actual SAM and inspected native attendance`, async () => {
    const f = await classCallFlowFixture(operation, true);
    try {
      if (operation === "cancel") assert.equal((await f.state()).policy.bookingEnabled, false, "class cancellation is independent of booking");
      await question(f, operation);
      const { turn, intent } = await selected(f);
      assert.deepEqual([f.mail.length, f.writes.length], [0, 0]);
      resultValue(await f.reception.startWorkflow(f.scope, turn, intent.operation, verificationNow, (await f.state()).conversationRevision,
        undefined, false, undefined, undefined, true, intent.classSelectionRef));
      await f.play(); assert.equal(f.flow.beginVerification(), true);
      for (let index = 0; index < 100 && !f.mail.length; index++) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(f.mail.length, 1); assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
      if (operation === "book") {
        resultValue(await f.reception.readBookingMenu(f.scope, f.turn("menu"), "2026-10-08", "2026-10-08", verificationNow));
        await f.play(); resultValue(await f.reception.selectBookingMenu(f.scope, f.turn("choice", "one"), 1, verificationNow));
      } else {
        const grant = await f.flow.cancellationProof(); assert.ok(grant);
        resultValue(await f.reception.checkAppointments(f.scope, f.turn("read"), grant.verificationRef, verificationNow, "2026-10-09T10:00:00.000Z", verificationNow));
        await f.play();
        resultValue(await f.reception.proposeAppointmentChange(f.scope, f.turn("cancel"), { kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" }, verificationNow));
      }
      const action = Object.values((await f.state()).actions).at(-1)!;
      assert.equal(action.status, "awaitingConfirmation");
      const presentation = (await f.state()).presentations[action.presentationId]!;
      assert.equal(presentation.kind, "speech");
      assert.match("approvedText" in presentation ? presentation.approvedText : "", /Reformer Pilates/);
      assert.equal(f.writes.length, 0);
      await f.play();
      resultValue(await f.reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, verificationNow));
      resultValue(await f.reception.drain(f.scope, f.callId, verificationNow));
      assert.equal((await f.state()).actions[action.key]!.status, "committed");
      assert.equal(f.writes.length, 1); assert.equal(f.recalls.length, 1);
      if (operation === "book") assert.equal(f.writes[0]!.booking_id, "191");
      else { assert.equal(f.native.attendees.find(row => row.id === "201")!.cancelled_at, verificationNow); assert.equal(f.native.attendees.find(row => row.id === "101")!.cancelled_at, null); }
      assert.equal(f.native.traffic.some(row => row.path.includes("individual_appointments")), false);
      for (const canary of verificationCanaries) assert.equal(JSON.stringify((await f.flow.publicIntentContext())?.classServices).includes(canary), false);
    } finally { await f.close(); }
  });

for (const fault of ["unplayed", "changed", "withdrawn", "ended", "stop", "expired"] as const)
  test(`E2E-396 ${fault} class service question cannot start verification or a native action`, async () => {
    const f = await classCallFlowFixture("book", true);
    try {
      await question(f, "book", fault !== "unplayed");
      if (fault === "changed" || fault === "withdrawn") {
        const approval = JSON.parse(await readFile(f.secondPath!, "utf8"));
        await writeFile(f.secondPath!, JSON.stringify({ ...approval, ...(fault === "changed" ? { revision: "changed", durationMinutes: 45 } : { enabled: false }) }));
      }
      if (fault === "ended") resultValue(await f.runtime.endCall(f.callId, f.sessionId, verificationNow));
      if (fault === "stop") resultValue(await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop"));
      if (fault === "expired") f.setTime("2026-10-04T06:03:00.000Z");
      const result = await f.flow.classServiceIntent(f.turn("second", "two"));
      assert.deepEqual(result, { kind: "clarify", reason: "serviceSelectionUnavailable" });
      assert.deepEqual([f.mail.length, f.writes.length, f.recalls.length], [0, 0, 0]);
    } finally { await f.close(); }
  });

test("E2E-396 forged, wrong-operation, changed and replayed service handles cannot choose a class implicitly", async () => {
  const f = await classCallFlowFixture("book", true);
  try {
    await question(f, "book"); const { intent, turn } = await selected(f);
    const query = { turnId: turn.turnId, scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.flowConfig.policyVersion, operation: "book" as const, classAttendance: true as const,
      expectedConversationRevision: (await f.state()).conversationRevision, signal: new AbortController().signal };
    assert.equal((await f.flow.startWorkflow(query)).ok, false);
    assert.equal((await f.flow.startWorkflow({ ...query, classSelectionRef: "class-service:forged" })).ok, false);
    assert.equal((await f.flow.startWorkflow({ ...query, operation: "cancel", classSelectionRef: intent.classSelectionRef! })).ok, false);
    const approval = JSON.parse(await readFile(f.secondPath!, "utf8"));
    await writeFile(f.secondPath!, JSON.stringify({ ...approval, revision: "changed-after-choice" }));
    assert.equal((await f.flow.startWorkflow({ ...query, classSelectionRef: intent.classSelectionRef! })).ok, false);
    assert.equal((await f.flow.startWorkflow({ ...query, classSelectionRef: intent.classSelectionRef! })).ok, false);
    assert.equal(f.mail.length, 0); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test("E2E-396 exact class names select only approved services and conflicting configuration is rejected", async () => {
  const f = await classCallFlowFixture("book", true);
  try {
    const result = resultValue(await resolver(f)(f.turn("named", "Book Reformer Pilates class")));
    assert.equal(result.kind, "workflow");
    assert.deepEqual(await f.flow.classServiceIntent(f.turn("unknown", "Book a swimming class")), { kind: "clarify", reason: "serviceSelectionUnavailable" });
    assert.equal((ClinikoCallFlow.create({ ...f.flowConfig, classAttendance: f.flowConfig.classServices![0]! })).ok, false);
    assert.equal(f.mail.length, 0);
  } finally { await f.close(); }
});

for (const fault of ["missing", "duplicateRef", "duplicateBinding", "wrongMember", "wrongType"] as const)
  test(`E2E-396 ${fault} catalogue entry cannot be skipped to expose a partial class service menu`, async () => {
    const f = await classCallFlowFixture("book", true);
    let flow: ClinikoCallFlow | undefined;
    try {
      const services = f.flowConfig.classServices!.map(service => ({ ...service }));
      if (fault === "missing") services[1]!.approvalPath += ".missing";
      if (fault === "duplicateBinding") services[1] = services[0]!;
      if (fault === "wrongMember") services[1]!.practitionerId = "24";
      if (fault === "wrongType") services[1]!.appointmentTypeId = "35";
      if (fault === "duplicateRef") {
        const value = JSON.parse(await readFile(f.secondPath!, "utf8"));
        await writeFile(f.secondPath!, JSON.stringify({ ...value, serviceRef: "mat-pilates" }));
      }
      flow = resultValue(ClinikoCallFlow.create({ ...f.flowConfig, classServices: services }));
      assert.deepEqual(await flow.classServiceIntent(f.turn("request", "Book a class")), { kind: "clarify", reason: "serviceSelectionUnavailable" });
      assert.equal((await flow.publicIntentContext())?.classServices, undefined);
      assert.deepEqual([f.mail.length, f.writes.length, f.recalls.length], [0, 0, 0]);
    } finally { flow?.dispose(); await f.close(); }
  });

test("E2E-396 a played second page exposes the fourth approved class and rejects a different selecting turn", async () => {
  const f = await classCallFlowFixture("book", true);
  let flow: ClinikoCallFlow | undefined;
  try {
    const services = [...f.flowConfig.classServices!];
    for (const index of [3, 4]) {
      const path = `${f.secondPath!}.${index}`;
      await writeFile(path, JSON.stringify({ ...f.approval, practitionerId: String(22 + index), appointmentTypeId: String(33 + index),
        serviceRef: `class-${index}`, className: `Class ${index}`, practitionerName: `Instructor ${index}` }), { mode: 0o600 });
      services.push({ ...services[0]!, approvalPath: path, practitionerId: String(22 + index), appointmentTypeId: String(33 + index) });
    }
    flow = resultValue(ClinikoCallFlow.create({ ...f.flowConfig, classServices: services }));
    const firstTurn = f.turn("first-page", "Book a class"), first = await flow.classServiceIntent(firstTurn);
    assert.equal(first?.kind, "classServiceQuestion");
    if (first?.kind !== "classServiceQuestion") throw new Error("missing first page");
    assert.equal(first.question.labels.length, 3); assert.equal(first.question.pages, 2);
    resultValue(await f.runtime.acceptTurn(firstTurn, first, verificationNow)); await f.play();
    const nextTurn = f.turn("next-page", "Next class services"), next = await flow.classServiceIntent(nextTurn);
    if (next?.kind !== "classServiceQuestion") throw new Error("missing next page");
    assert.equal(next.question.page, 2); assert.match(next.question.labels[0]!, /Class 4.*Instructor 4/);
    resultValue(await f.runtime.acceptTurn(nextTurn, next, verificationNow)); await f.play();
    const choiceTurn = f.turn("page-choice", "one"), choice = await flow.classServiceIntent(choiceTurn);
    if (choice?.kind !== "workflow") throw new Error("missing page choice");
    // Preparation is still private and must target the selected class binding.
    const selected = await flow.startWorkflow({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.flowConfig.policyVersion,
      operation: "book", classAttendance: true, classSelectionRef: choice.classSelectionRef!, turnId: "wrong-turn", signal: new AbortController().signal,
      expectedConversationRevision: (await f.state()).conversationRevision });
    assert.equal(selected.ok, false); assert.equal(f.mail.length, 0); assert.equal(f.writes.length, 0);
  } finally { flow?.dispose(); await f.close(); }
});

for (const flag of ["bookingEnabled", "cancellationEnabled", "staffWorkEnabled"] as const)
  test(`E2E-396 current ${flag} withdrawal prevents a class service question despite an older active call policy`, async () => {
    const operation = flag === "cancellationEnabled" ? "cancel" : "book";
    const f = await classCallFlowFixture(operation, true);
    let flow: ClinikoCallFlow | undefined;
    try {
      const original = f.flowConfig.policies;
      const policies = new Proxy(original, { get(target, key) {
        if (key === "read") return async (...args: Parameters<typeof target.read>) => {
          const current = await target.read(...args);
          return current.ok ? ok({ ...current.value, [flag]: false }) : current;
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      flow = resultValue(ClinikoCallFlow.create({ ...f.flowConfig, policies }));
      assert.deepEqual(await flow.classServiceIntent(f.turn("disabled", `${operation} a class`)), { kind: "clarify", reason: "serviceSelectionUnavailable" });
      assert.deepEqual([f.mail.length, f.writes.length, f.recalls.length], [0, 0, 0]);
    } finally { flow?.dispose(); await f.close(); }
  });
