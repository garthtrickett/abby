import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { classBookingFixture } from "../support/class-booking.ts";
import { classAttendee, classLink } from "../support/class-attendance.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { OwnerFileClassPolicy } from "../../src/standalone/owner-file-class-policy.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { ClinikoClassSession } from "../../src/standalone/cliniko-class-session.ts";
import { classCancellationFixture } from "../support/class-cancellation.ts";
import { classMoveFixture } from "../support/class-move.ts";

async function confirmPass(f: Awaited<ReturnType<typeof classBookingFixture>>) {
  let result = await f.confirm();
  const state = resultValue(result), notice = state.pendingPresentationId ? state.presentations[state.pendingPresentationId] : undefined;
  if (notice?.kind === "notice" && notice.confirmationWaitSeconds) {
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    assert.match(notice.approvedText, /say yes again/);
    await f.play(); await f.pause(notice.confirmationWaitSeconds + 1);
    result = await f.confirm();
  }
  return result;
}

test("E2E-406 actual class pass booking binds one approved case to played consent, reviewed send and the last available native session", async () => {
  const f = await classBookingFixture({ passes: true });
  try {
    await f.verify(); const action = await f.propose();
    const proposal = (await f.state()).presentations[action.presentationId]!;
    assert.equal(proposal.kind, "speech"); assert.match(proposal.approvedText, /uses one session from your approved class pass/);
    for (const secret of [f.pass.caseId, f.pass.entitlementRef, "private-pass-name-canary", "private-pass-notes-canary", "private-pass-referral-canary"])
      assert.equal(JSON.stringify(proposal).includes(secret), false);
    assert.deepEqual([f.recalls.length, f.writes.length], [0, 0]);
    resultValue(await confirmPass(f)); resultValue(await f.drain());
    assert.equal((await f.state()).actions[action.key]!.status, "committed", JSON.stringify({ claims: f.claims, writes: f.writes.length }));
    assert.deepEqual([f.recalls.length, f.writes.length], [1, 1]); assert.equal(f.writes[0]!.patient_case_id, f.pass.caseId);
    const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes)); assert.equal(review.request.operation.kind, "classBook");
    if (review.request.operation.kind !== "classBook") assert.fail("wrong review");
    assert.deepEqual(review.request.operation.pass, { patientCaseId: f.pass.caseId, entitlementRef: f.pass.entitlementRef,
      usageFingerprint: review.request.operation.pass!.usageFingerprint, used: 1, maximum: 2 });
    assert.match(String(f.recalls[0]!.notes), /class attendance review v2/);
    assert.ok(f.pass.queries.some(q => q.phase === "commit")); assert.equal(f.pass.queries.some(q => q.phase === "inspection"), false);
    assert.equal(f.pass.rows.length, 2); assert.equal(f.native.attendees.filter(row => row.id === "401").length, 1); assert.ok(f.claims <= 200);
    resultValue(await f.drain()); assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});

for (const fault of ["permission", "full", "expired", "foreignPatient", "missingAssociation"] as const)
  test(`E2E-406 ${fault} pass cannot publish a selectable native class booking`, async () => {
    const f = await classBookingFixture({ passes: true });
    try {
      await f.verify();
      if (fault === "permission") f.pass.deny();
      if (fault === "full") f.pass.record.max_sessions = 1;
      if (fault === "expired") f.pass.record.expiry_date = "2026-10-07";
      if (fault === "foreignPatient") f.pass.record.patient = classLink("patients", "999");
      if (fault === "missingAssociation") f.pass.record.attendee_ids = ["601", "602"];
      const menu = await f.reception.readBookingMenu(f.scope, f.turn("menu"), "2026-10-08", "2026-10-08", verificationNow);
      assert.equal(menu.ok, true); assert.equal(Object.keys((await f.state()).actions).length, 0);
      assert.deepEqual([f.recalls.length, f.writes.length], [0, 0]);
    } finally { await f.close(); }
  });

for (const afterReview of [false, true]) for (const fault of ["authority", "case", "entitlement", "consumption", "counterRule", "expiry"] as const)
  test(`E2E-406 ${fault} changes ${afterReview ? "after" : "before"} the owned pass review cannot send attendance`, async () => {
    const f = await classBookingFixture({ passes: true });
    try {
      await f.verify(); const action = await f.propose();
      const change = async () => {
        if (fault === "authority") f.pass.deny();
        if (fault === "case") f.pass.select({ patientCaseId: "811222333444555667", entitlementRef: f.pass.entitlementRef });
        if (fault === "entitlement") f.pass.select({ patientCaseId: f.pass.caseId, entitlementRef: "replacement-entitlement" });
        if (fault === "consumption") f.pass.record.max_sessions = 1;
        if (fault === "counterRule") f.pass.record.include_cancelled_attendees = true;
        if (fault === "expiry") f.pass.record.expiry_date = "2026-10-07";
      };
      resultValue(await confirmPass(f)); if (afterReview) f.onRecall(change); else await change();
      resultValue(await f.drain());
      assert.notEqual((await f.state()).actions[action.key]!.status, "committed");
      assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, Number(afterReview));
      resultValue(await f.drain()); assert.equal(f.writes.length, 0);
    } finally { await f.close(); }
  });

for (const fault of ["wrongCase", "lost", "extraUse", "sameNetUse", "authority", "expiry", "deleted"] as const)
  test(`E2E-406 ${fault} after pass dispatch preserves exact creation truth without replay`, async () => {
    const f = await classBookingFixture({ passes: true });
    try {
      await f.verify(); const action = await f.propose();
      if (fault === "lost") f.loseWrite();
      f.onWrite(async () => {
        const row = f.pass.rows.find(row => row.id === "401")!;
        if (fault === "wrongCase") row.patient_case = classLink("patient_cases", "811222333444555667");
        if (fault === "authority") f.pass.deny();
        if (fault === "expiry") f.pass.record.expiry_date = "2026-10-07";
        if (fault === "deleted") row.deleted_at = verificationNow;
        if (fault === "extraUse" || fault === "sameNetUse") {
          if (fault === "sameNetUse") f.pass.rows[0]!.cancelled_at = verificationNow;
          f.pass.rows.push({ ...classAttendee("602", "82", verificationCanaries[2]!), arrived: null, patient_case: classLink("patient_cases", f.pass.caseId) });
          (f.pass.record.attendee_ids as string[]).push("602");
        }
      });
      resultValue(await confirmPass(f)); resultValue(await f.drain());
      assert.equal((await f.state()).actions[action.key]!.status, ["wrongCase", "lost", "deleted"].includes(fault) ? "uncertain" : "committed");
      assert.deepEqual([f.recalls.length, f.writes.length], [1, 1]);
      resultValue(await f.drain()); assert.equal(f.writes.length, 1);
    } finally { await f.close(); }
  });

test("E2E-406 unplayed pass consent cannot send a review or consume an attendance", async () => {
  const f = await classBookingFixture({ passes: true });
  try { await f.verify(); await f.propose(); await f.confirm(false); await f.drain(); assert.deepEqual([f.recalls.length, f.writes.length], [0, 0]); }
  finally { await f.close(); }
});

for (const fault of ["abort", "correction", "permission"] as const)
  test(`E2E-406 pending pass budget guidance cannot affirm after ${fault}`, async () => {
    const f = await classBookingFixture({ passes: true });
    let release = () => {};
    try {
      await f.verify(); const action = await f.propose(); await f.play();
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const budget = f.classSessionConfig.cliniko.rateBudget, original = budget.checkHeadroom;
      assert.ok(original);
      Object.defineProperty(budget, "checkHeadroom", { value: async (count: number) => { entered(); await gate; return original(count); } });
      const stop = new AbortController(), pending = f.reception.affirm(f.scope, f.turn("pending", "Yes"), action.key, action.digest, verificationNow, undefined, stop.signal);
      await started;
      if (fault === "abort") stop.abort();
      if (fault === "permission") f.pass.deny();
      if (fault === "correction") resultValue(await f.runtime.nonAffirmativeFinal(f.turn("correct", "No, another day"), (await f.state()).conversationRevision, verificationNow));
      release(); await pending; await f.drain();
      assert.deepEqual([f.recalls.length, f.writes.length], [0, 0]);
      assert.equal((await f.state()).actions[action.key]!.status, fault === "abort" ? "awaitingConfirmation" : "canceled");
    } finally { release(); await f.close(); }
  });

test("E2E-406 admitted class session cannot substitute channel proof for independent pass authority", async () => {
  const f = await classBookingFixture({ passes: true });
  try {
    const { classPassAuthority: _removed, ...config } = f.classSessionConfig;
    const result = await ClinikoClassSession.create(config);
    if (result.ok) result.value.dispose();
    assert.equal(result.ok, false); assert.deepEqual([f.mail.length, f.recalls.length, f.writes.length], [0, 0, 0]);
  } finally { await f.close(); }
});

for (const fault of ["missing", "counting", "dates", "money", "legacy"] as const)
  test(`E2E-406 owner pass ${fault} contract is not inferred from an ordinary class approval`, async () => {
    const f = await classBookingFixture({ passes: true });
    try {
      const cases = { ...f.approval.caseSessions! } as Record<string, unknown>;
      if (fault === "counting") cases.counting = "unproven";
      if (fault === "dates") cases.dates = "utc";
      if (fault === "money") cases.financialAuthority = "caseCounter";
      if (fault === "missing") {
        const { caseSessions: _removed, ...withoutCases } = f.approval;
        await writeFile(f.path, JSON.stringify(withoutCases), { mode: 0o600 });
      } else await f.replacePolicy({ caseSessions: cases as NonNullable<typeof f.approval.caseSessions>,
        ...(fault === "legacy" ? { membership: "independentHost" } : {}) });
      const policy = await OwnerFileClassPolicy.capture({ ...f.policy.binding(), path: f.path, directory: new OwnerFileAdminDirectory(f.accountPath, f.scope), clock: () => verificationNow });
      assert.equal(policy.ok, false);
    } finally { await f.close(); }
  });

test("E2E-406 native pass cancellation and movement require their own consumption/release workflow", async () => {
  const template = await classBookingFixture({ passes: true });
  const caseSessions = template.approval.caseSessions!; await template.close();
  for (const operation of ["cancel", "sourceMove", "destinationMove"] as const) {
    const f = operation === "cancel" ? await classCancellationFixture() : await classMoveFixture(true);
    try {
      if ("replaceSource" in f) {
        if (operation === "sourceMove") await f.replaceSource({ membership: "nativeCaseSessions", caseSessions });
        else await f.replaceDestination({ membership: "nativeCaseSessions", caseSessions });
      } else await f.replacePolicy({ membership: "nativeCaseSessions", caseSessions });
      const result = await ClinikoClassSession.create(f.classSessionConfig);
      if (result.ok) result.value.dispose();
      assert.equal(result.ok, false); assert.deepEqual([f.mail.length, f.recalls.length, f.writes.length], [0, 0, 0]);
    } finally { await f.close(); }
  }
});
