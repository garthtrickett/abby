import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { classCancellationFixture } from "../support/class-cancellation.ts";
import { classAttendee, classLink } from "../support/class-attendance.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { ClinikoClassSession } from "../../src/standalone/cliniko-class-session.ts";
import { OwnerFileClassPolicy } from "../../src/standalone/owner-file-class-policy.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";

type Fixture = Awaited<ReturnType<typeof classCancellationFixture>>;
async function confirm(f: Fixture) {
  let found = await f.confirm();
  const state = resultValue(found), notice = state.pendingPresentationId ? state.presentations[state.pendingPresentationId] : undefined;
  if (notice?.kind === "notice" && notice.confirmationWaitSeconds) {
    assert.match(notice.approvedText, /say yes again/); assert.match(notice.approvedText, /haven't cancelled/);
    assert.deepEqual([f.writes.length, f.recalls.length], [0, 0]);
    await f.play(); await f.pause(notice.confirmationWaitSeconds + 1); found = await f.confirm();
  }
  return resultValue(found);
}

for (const effect of ["releaseOne", "unchanged", "consumeOne"] as const)
  test(`E2E-407 ordinary pass cancellation ${effect} binds actual native rules to played terms, review and exact final case effect`, async () => {
    const f = await classCancellationFixture({ passes: effect });
    try {
      const shared = structuredClone(f.native.groups), other = structuredClone(f.native.attendees.filter(r => r.id !== "101"));
      await f.verify(); const action = await f.propose(), presentation = (await f.state()).presentations[action.presentationId]!;
      assert.equal(presentation.kind, "speech");
      assert.match(presentation.approvedText, effect === "releaseOne" ? /One session will stop counting as used/ : effect === "consumeOne" ? /will count as one used pass session/ : /usage will stay unchanged/);
      for (const secret of [f.pass.caseId, f.pass.entitlementRef, "private-cancel-case-name", "private-cancel-case-notes", "private-cancel-case-referral"])
        assert.equal(JSON.stringify(presentation).includes(secret), false);
      await confirm(f); resultValue(await f.drain());
      assert.equal((await f.state()).actions[action.key]!.status, "committed", JSON.stringify({ claims: f.claims, writes: f.writes.length }));
      assert.deepEqual([f.recalls.length, f.writes.length], [1, 1]); assert.equal(f.native.attendees.find(r => r.id === "101")!.cancelled_at, f.classSessionConfig.clock());
      const operation = resultValue(decodeClinikoReview(f.recalls[0]!.notes)).request.operation;
      assert.equal(operation.kind, "classCancel"); if (operation.kind !== "classCancel") assert.fail("wrong review");
      assert.equal(operation.pass?.patientCaseId, f.pass.caseId); assert.equal(operation.pass?.effect, effect);
      assert.equal(operation.pass?.used, effect === "consumeOne" ? 1 : 2); assert.match(String(f.recalls[0]!.notes), /class cancellation pass review v1/);
      assert.equal(f.pass.rows.length, 2); assert.deepEqual(f.native.groups, shared); assert.deepEqual(f.native.attendees.filter(r => r.id !== "101"), other);
      assert.ok(f.pass.queries.some(q => q.effect === effect && q.phase === "inspection"));
      await f.drain(); assert.equal(f.writes.length, 1);
    } finally { await f.close(); }
  });

for (const state of ["expired", "closed", "overdrawn"] as const)
  test(`E2E-407 ${state} pass does not prevent cancelling attendance or gain renewed validity/money`, async () => {
    const f = await classCancellationFixture({ passes: "releaseOne" });
    try {
      if (state === "expired") f.pass.record.expiry_date = "2026-10-02";
      if (state === "closed") f.pass.record.closed_at = verificationNow;
      if (state === "overdrawn") f.pass.record.max_sessions = 1;
      const before = structuredClone(f.pass.record);
      await f.verify(); const action = await f.propose(); await confirm(f); resultValue(await f.drain());
      assert.equal((await f.state()).actions[action.key]!.status, "committed");
      assert.deepEqual(f.pass.record, before, "cancelling changes no case dates, credit, maximum or activity flags"); assert.equal(f.writes.length, 1);
    } finally { await f.close(); }
  });

for (const countedDna of [false, true])
  test(`E2E-407 an existing DNA ${countedDna ? "counted" : "excluded"} by the pass has the actual cancellation delta`, async () => {
    const effect = countedDna ? "releaseOne" : "unchanged", f = await classCancellationFixture({ passes: effect });
    try {
      f.pass.rows[0]!.arrived = false; f.pass.record.include_dna_attendees = countedDna; f.pass.record.include_cancelled_attendees = false;
      await f.verify(); const action = await f.propose(); await confirm(f); await f.drain();
      assert.equal((await f.state()).actions[action.key]!.status, "committed");
      const operation = resultValue(decodeClinikoReview(f.recalls[0]!.notes)).request.operation;
      assert.equal(operation.kind, "classCancel"); if (operation.kind !== "classCancel") assert.fail("wrong pass review");
      assert.equal(operation.pass?.effect, effect); assert.equal(operation.pass?.used, countedDna ? 2 : 1);
    } finally { await f.close(); }
  });

for (const fault of ["authority", "effectAuthority", "foreignPatient", "wrongCase", "wrongOccurrence", "missingAssociation"] as const)
  test(`E2E-407 ${fault} cannot disclose a selectable pass attendance or prepare cancellation`, async () => {
    const f = await classCancellationFixture({ passes: "releaseOne" });
    try {
      await f.verify();
      if (fault === "authority") f.pass.deny();
      if (fault === "effectAuthority") f.pass.denyEffect();
      if (fault === "foreignPatient") f.pass.record.patient = classLink("patients", "999");
      if (fault === "wrongCase") f.pass.rows[0]!.patient_case = classLink("patient_cases", "811222333444555667");
      if (fault === "wrongOccurrence") f.pass.rows[0]!.booking = classLink("bookings", "94");
      if (fault === "missingAssociation") f.pass.record.attendee_ids = ["601"];
      const grant = await f.session.verified(); assert.ok(grant);
      const read = await f.host.list(f.scope, grant.verificationRef, verificationNow, "2026-10-09T10:00:00.000Z", verificationNow);
      assert.equal(read.ok, false); assert.deepEqual([f.recalls.length, f.writes.length], [0, 0]);
    } finally { await f.close(); }
  });

for (const afterReview of [false, true]) for (const fault of ["authority", "case", "entitlement", "rules", "use"] as const)
  test(`E2E-407 ${fault} changes ${afterReview ? "after" : "before"} the pass cancellation review cannot send`, async () => {
    const f = await classCancellationFixture({ passes: "releaseOne" });
    try {
      await f.verify(); const action = await f.propose(); await confirm(f);
      const change = async () => {
        if (fault === "authority") f.pass.deny();
        if (fault === "case") f.pass.select({ patientCaseId: "811222333444555667", entitlementRef: f.pass.entitlementRef });
        if (fault === "entitlement") f.pass.select({ patientCaseId: f.pass.caseId, entitlementRef: "replacement-entitlement" });
        if (fault === "rules") f.pass.record.include_cancelled_attendees = true;
        if (fault === "use") { f.pass.rows.push({ ...classAttendee("602", "82", verificationCanaries[2]!), arrived: null, patient_case: classLink("patient_cases", f.pass.caseId) }); (f.pass.record.attendee_ids as string[]).push("602"); }
      };
      if (afterReview) f.onRecall(change); else await change();
      resultValue(await f.drain()); assert.notEqual((await f.state()).actions[action.key]!.status, "committed");
      assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, Number(afterReview)); assert.equal(f.pass.rows[0]!.cancelled_at, null);
    } finally { await f.close(); }
  });

for (const fault of ["lost", "authority", "case", "rule", "extraUse", "sameNetUse", "removed"] as const)
  test(`E2E-407 ${fault} after cancelling stays uncertain without inventing pass credit or retrying`, async () => {
    const f = await classCancellationFixture({ passes: "releaseOne" });
    try {
      await f.verify(); const action = await f.propose(); if (fault === "lost") f.loseWrite();
      f.onWrite(async () => {
        if (fault === "authority") f.pass.deny();
        if (fault === "case") f.pass.rows[0]!.patient_case = classLink("patient_cases", "811222333444555667");
        if (fault === "rule") f.pass.record.include_cancelled_attendees = true;
        if (fault === "removed") { f.pass.rows.splice(0, 1); f.pass.record.attendee_ids = ["601"]; }
        if (fault === "extraUse" || fault === "sameNetUse") {
          if (fault === "sameNetUse") f.pass.rows[1]!.cancelled_at = verificationNow;
          f.pass.rows.push({ ...classAttendee("602", "82", verificationCanaries[2]!), arrived: null, patient_case: classLink("patient_cases", f.pass.caseId) }); (f.pass.record.attendee_ids as string[]).push("602");
        }
      });
      await confirm(f); resultValue(await f.drain()); assert.equal((await f.state()).actions[action.key]!.status, "uncertain");
      assert.deepEqual([f.recalls.length, f.writes.length], [1, 1]); await f.drain(); assert.equal(f.writes.length, 1);
    } finally { await f.close(); }
  });

test("E2E-407 unplayed pass cancellation terms cannot write or release a session", async () => {
  const f = await classCancellationFixture({ passes: "releaseOne" });
  try { await f.verify(); await f.propose(); await f.confirm(false); await f.drain(); assert.deepEqual([f.recalls.length, f.writes.length], [0, 0]); }
  finally { await f.close(); }
});

test("E2E-407 an admitted pass cancellation needs independent current cancellation authority", async () => {
  const f = await classCancellationFixture({ passes: "releaseOne" });
  try {
    const { classPassCancellationAuthority: _removed, ...config } = f.classSessionConfig;
    const found = await ClinikoClassSession.create(config); if (found.ok) found.value.dispose();
    assert.equal(found.ok, false); assert.deepEqual([f.mail.length, f.recalls.length, f.writes.length], [0, 0, 0]);
  } finally { await f.close(); }
});

for (const fault of ["abort", "correction", "authority"] as const)
  test(`E2E-407 pending cancellation capacity cannot dispatch after ${fault}`, async () => {
    const f = await classCancellationFixture({ passes: "releaseOne" }); let release = () => {};
    try {
      await f.verify(); const action = await f.propose(); await f.play();
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const budget = f.classSessionConfig.cliniko.rateBudget, original = budget.checkHeadroom;
      assert.ok(original);
      Object.defineProperty(budget, "checkHeadroom", { value: async (n: number) => { entered(); await gate; return original(n); } });
      const stop = new AbortController(), pending = f.reception.affirm(f.scope, f.turn("pending", "Yes"), action.key, action.digest, verificationNow, undefined, stop.signal);
      await started;
      if (fault === "abort") stop.abort();
      if (fault === "authority") f.pass.deny();
      if (fault === "correction") resultValue(await f.runtime.nonAffirmativeFinal(f.turn("correction", "No, don't cancel"), (await f.state()).conversationRevision, verificationNow));
      release(); await pending; await f.drain();
      assert.equal((await f.state()).actions[action.key]!.status, fault === "abort" ? "awaitingConfirmation" : "canceled");
      assert.equal(f.pass.rows[0]!.cancelled_at, null); assert.deepEqual([f.recalls.length, f.writes.length], [0, 0]);
    } finally { release(); await f.close(); }
  });

test("E2E-407 unknown pass review acknowledgement cannot cancel attendance or free a session", async () => {
  const f = await classCancellationFixture({ passes: "releaseOne" });
  try {
    await f.verify(); const action = await f.propose(); f.loseReview(); await confirm(f); await f.drain();
    assert.equal((await f.state()).actions[action.key]!.status, "uncertain"); assert.deepEqual([f.recalls.length, f.writes.length], [1, 0]);
    assert.equal(f.pass.rows[0]!.cancelled_at, null); await f.drain(); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

for (const fault of ["version", "missingEffect", "autoRefund", "unsafeText"] as const)
  test(`E2E-407 ${fault} cannot become an approved native pass cancellation contract`, async () => {
    const f = await classCancellationFixture({ passes: "releaseOne" });
    try {
      const document = structuredClone(f.approval) as unknown as { caseSessions: { cancellation: Record<string, unknown> } };
      const contract = document.caseSessions.cancellation;
      if (fault === "version") contract.version = "";
      if (fault === "missingEffect") delete contract.consumeOne;
      if (fault === "autoRefund") contract.autoRefund = true;
      if (fault === "unsafeText") contract.releaseOne = "unapproved\ntext";
      await writeFile(f.path, JSON.stringify(document), { mode: 0o600 });
      const policy = await OwnerFileClassPolicy.capture({ ...f.policy.binding(), path: f.path, directory: new OwnerFileAdminDirectory(f.accountPath, f.scope), clock: () => verificationNow });
      assert.equal(policy.ok, false);
    } finally { await f.close(); }
  });
