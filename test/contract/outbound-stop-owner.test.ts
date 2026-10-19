import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { outboundStopOwnerFixture } from "../support/outbound-stop-owner.ts";
import { outboundContactSourceFixture } from "../support/outbound-contact-source.ts";
import { value } from "../support/outbound-records.ts";
import { ClinikoOutboundContactSource } from "../../src/cliniko/outbound-contact-source.ts";
import { decodeOutboundContactReview, encodeOutboundContactReview } from "../../src/cliniko/outbound-contact-review.ts";
import { encodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";

test("private lineage export has a separate decoded grant and does not expand old evidence", async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close);
  f.controls.allow = q => q.operation !== "readContactLineage";
  const source = value(f.make()); assert.equal(Object.hasOwn(value(await f.read()), "history"), false);
  assert.deepEqual(await source.readHistoryForRequest(f.request, new AbortController().signal), { ok: false, error: { kind: "forbidden" } });
  f.controls.allow = () => true;
  const found = value(await source.readHistoryForRequest(f.request, new AbortController().signal));
  assert.equal(found.history.length, 1); assert.equal(found.history[0]!.review.actionRef, f.first.actionRef); assert.equal(Object.isFrozen(found.history), true);
});
test("selected authenticated stop retains unknown consent and blocked DNC using pre-dispatch native IDs", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close);
  const result = value(await f.retainStop()); assert.equal(result.kind, "accepted"); assert.equal(f.dncPosts.length, 1);
  const review = value(decodeOutboundContactReview(f.dncPosts[0]!.notes));
  assert.equal(review.actionRef, f.attempt.dncReferences!.actionRef); assert.equal(review.approvalRef, f.attempt.dncReferences!.approvalRef);
  assert.equal(review.reviewerRef, f.stopConfig.dnc.automationPrincipalRef); assert.equal(review.consent, "unknown"); assert.equal(review.doNotCall, "blocked");
  assert.equal(review.reconsentApprovalRef, null); assert.deepEqual(review.purposes, ["followUp", "sickDay"]);
  assert.deepEqual([...f.dncBurned], [review.actionRef]); assert.equal(f.held.size, 1); assert.equal(f.calls.length, 1);
  assert.equal(value(await f.retainStop()).kind, "existingDecision"); assert.equal(f.dncPosts.length, 1);
});
for (const kind of ["none", "unknown"] as const)
  test(`provider ${kind} neither writes a decision nor grants future contact`, async t => {
    const f = await outboundStopOwnerFixture(); t.after(f.close); f.stopState.kind = kind;
    assert.deepEqual(value(await f.retainStop()), { kind: "unresolved" }); assert.equal(f.dncPosts.length, 0); assert.equal(f.dncBurned.size, 0); assert.equal(f.held.size, 1);
  });
for (const patch of [{ effectRef: randomUUID() }, { capacityAllocationRef: randomUUID() }, { provider: { ref: "foreign", bindingDigest: "c".repeat(64) } },
  { number: "+12025550999" }, { participant: "verifiedPatient" }, { stoppedAt: "2020-01-01T00:00:00.000Z" },
  { observedAt: "2030-01-01T00:00:00.000Z" }, { providerCallId: "private-native-call" }])
  test(`foreign or unsupported provider stop refuses ${Object.keys(patch)[0]}`, async t => {
    const f = await outboundStopOwnerFixture(); t.after(f.close); f.stopState.patch = patch;
    assert.equal((await f.retainStop()).ok, false); assert.equal(f.dncPosts.length, 0); assert.equal(f.dncBurned.size, 0);
  });
for (const denial of ["owner", "record", "producer", "policy", "current"] as const)
  test(`independent ${denial} denial cannot retain an automatic stop decision`, async t => {
    const f = await outboundStopOwnerFixture(); t.after(f.close);
    if (denial === "owner") f.stopState.allow = false;
    if (denial === "record") f.stopState.record = false;
    if (denial === "producer") f.stopState.producer = false;
    if (denial === "policy") await f.replaceStopPolicy({ enabled: false });
    if (denial === "current") f.stopState.live = false;
    assert.equal((await f.retainStop()).ok, false); assert.equal(f.dncPosts.length, 0);
  });
test("legacy native context cannot invent future DNC identities", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close); const { dncReferences: _dnc, ...old } = f.attempt;
  f.row.notes = value(encodeOutboundLaunchAttempt(old)); assert.equal((await f.retainStop()).ok, false); assert.equal(f.stopState.inspectCount, 0); assert.equal(f.dncPosts.length, 0);
});
test("lost native acknowledgement remains consumed across a fresh owner", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close); f.stopState.response = () => { throw Error("Synthetic lost native ACK"); };
  assert.deepEqual(value(await f.retainStop()), { kind: "uncertain" }); assert.equal(f.dncPosts.length, 1);
  const cold = value(f.makeStop()); assert.equal(value(await cold.retainStopOnce(f.stopBinding, new AbortController().signal)).kind, "existingDecision"); assert.equal(f.dncPosts.length, 1);
});
test("exact native acknowledgement survives later owner grant withdrawal", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close); f.stopState.response = row => { f.stopState.live = false; return Response.json(row, { status: 201 }); };
  assert.equal(value(await f.retainStop()).kind, "accepted"); assert.equal(f.dncPosts.length, 1);
});
test("closed original and possible records still permit a restrictive recovery observation", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close);
  for (const row of [f.row, f.requestRow]) { row.recalled = true; row.recalled_at = f.state.now; row.archived_at = f.state.now; row.updated_at = f.state.now; }
  assert.equal(value(await f.retainStop()).kind, "accepted"); assert.equal(f.calls.length, 1);
});
test("a changed original request does not become a new contact or write authority", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close); f.requestRow.notes = "changed private context";
  assert.equal((await f.retainStop()).ok, false); assert.equal(f.dncPosts.length, 0);
});
test("policy expiry during provider observation refuses before DNC exclusion", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close); f.stopState.beforeInspect = () => { f.state.now = f.policyApproval.effectiveUntil; };
  assert.equal((await f.retainStop()).ok, false); assert.equal(f.dncBurned.size, 0); assert.equal(f.dncPosts.length, 0);
});
test("provider abort cannot write after the observation finishes late", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close); const controller = new AbortController();
  f.stopState.beforeInspect = async () => { controller.abort(); await new Promise<void>(() => {}); };
  assert.equal((await f.retainStop(controller.signal)).ok, false); assert.equal(f.dncPosts.length, 0);
});
test("current patient phone changes cannot erase the authenticated actual dialled stop", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close);
  f.contactControls.patient.patient_phone_numbers = [{ number: "+12025550999", phone_type: "Mobile" }];
  assert.equal(value(await f.retainStop()).kind, "accepted");
  assert.equal(value(decodeOutboundContactReview(f.dncPosts[0]!.notes)).recipient.number, f.request.recipient.number);
});
test("a later separately approved reconsent cannot cause replay of an already recorded stop", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close); assert.equal(value(await f.retainStop()).kind, "accepted");
  const stop = value(decodeOutboundContactReview(f.dncPosts[0]!.notes));
  f.state.now = "2026-11-02T00:00:01.000Z";
  const reconsent = f.next(stop, { reviewerRef: "human-clinic-reviewer", consent: "granted", doNotCall: "clear", reconsentApprovalRef: randomUUID(),
    reviewedAt: f.state.now, effectiveFrom: f.state.now });
  const previous = f.contactControls.rows.find(r => r.id === "300"); assert.ok(previous);
  const row: Record<string, unknown> & { id: string } = { ...previous, id: "301" }; f.contactControls.rows.push(row);
  // Use the underlying native row's links and canonical content for the new
  // independently granted human review; the automatic owner grants none of it.
  row.notes = value(encodeOutboundContactReview(reconsent)); row.links = { self: "https://api.au5.cliniko.com/v1/recalls/301" };
  row.created_at = f.state.now; row.updated_at = f.state.now;
  assert.equal(value(await f.retainStop()).kind, "existingDecision"); assert.equal(f.dncPosts.length, 1);
});
test("late lineage grant cannot return a changed history as a stable observation", async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close); let changed = false;
  f.controls.allow = q => { if (q.operation === "readContactLineage" && !changed) {
    changed = true; const next = f.next(f.first); f.controls.rows.push(f.row(next, "102"));
  } return true; };
  assert.deepEqual(await value(f.make()).readHistoryForRequest(f.request, new AbortController().signal), { ok: false, error: { kind: "mismatched" } });
});
test("uncertain native dispatch without a retained row is never replayed by a fresh owner", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close); f.stopState.beforeStore = () => { throw Error("Synthetic native write not observed"); };
  assert.deepEqual(value(await f.retainStop()), { kind: "uncertain" }); assert.equal(f.dncPosts.length, 1);
  assert.equal((await value(f.makeStop()).retainStopOnce(f.stopBinding, new AbortController().signal)).ok, false);
  assert.equal(f.dncPosts.length, 1); assert.equal(f.dncBurned.size, 1);
});
test("source read grant withdrawal during native write preparation prevents the POST", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close); f.stopState.beforeRecord = () => { f.retire(); };
  assert.equal((await f.retainStop()).ok, false); assert.equal(f.dncPosts.length, 0);
});
test("disabled clinic policy during write preparation prevents the POST", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close); f.stopState.beforeRecord = () => f.replaceStopPolicy({ enabled: false });
  assert.equal((await f.retainStop()).ok, false); assert.equal(f.dncPosts.length, 0);
});
test("runtime credential rotation during report observation cannot write under old approval", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close); f.stopState.beforeInspect = () => { f.providerBinding.bindingDigest = "f".repeat(64); };
  assert.equal((await f.retainStop()).ok, false); assert.equal(f.dncPosts.length, 0); assert.equal(f.dncBurned.size, 0);
});
test("future DNC identities cannot collide with prior clinic approval identities", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close);
  f.row.notes = value(encodeOutboundLaunchAttempt({ ...f.attempt, dncReferences: { ...f.attempt.dncReferences!, approvalRef: f.first.approvalRef } }));
  assert.equal((await f.retainStop()).ok, false); assert.equal(f.dncPosts.length, 0); assert.equal(f.dncBurned.size, 0);
});
test("concurrent native stop observers cannot append two decisions", async t => {
  const f = await outboundStopOwnerFixture(); t.after(f.close);
  const first = value(f.makeStop()), second = value(f.makeStop()), signal = new AbortController().signal;
  const results = await Promise.all([first.retainStopOnce(f.stopBinding, signal), second.retainStopOnce(f.stopBinding, signal)]);
  assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1);
  assert.equal(f.dncPosts.length, 1); assert.equal(f.dncBurned.size, 1); assert.equal(f.calls.length, 1); assert.equal(f.held.size, 1);
});
