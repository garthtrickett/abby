import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ClinikoClassAttendanceMove } from "../../src/standalone/cliniko-class-attendance-move.ts";
import type { ClassMoveStageConfirmation, ClassMoveStagePermit, ClassMoveStageResult } from "../../src/standalone/cliniko-class-move-stages.ts";
import { classMovementCanContinue, classMovementProgressText, readClassMovementProgress } from "../../src/core/class-movement-progress.ts";
import { claimClinikoBudget } from "../../src/cliniko/read-budget.ts";
import { err } from "../../src/core/model.ts";
import { classLink } from "../support/class-attendance.ts";
import { decodeClinikoReview, encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { classPassMoveFixture } from "../support/class-pass-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const version = "three-window-v1";
function assertPublicStageProgress(result: ClassMoveStageResult) {
  if (result.kind !== "staged") return;
  assert.equal(readClassMovementProgress(result.observation), undefined, "native observations are not public SAM records");
  const { original, replacement, caseAssociation } = result.observation;
  const progress = readClassMovementProgress({ original, replacement, caseAssociation }); assert.ok(progress);
  assert.equal(classMovementCanContinue(progress, result.next), true);
  assert.match(classMovementProgressText(progress), /overall class move is not confirmed/);
}
async function fixture(different = false, largest = false) {
  const f = await classPassMoveFixture({ history: 999, rosterHistory: largest ? 499 : 201, differentCase: different, differentService: different });
  const port: typeof fetch = async (input, init) => {
    const u = new URL(String(input)), relation = largest && /^\/v1\/practitioners\/(22|23)\/(businesses|appointment_types)$/.exec(u.pathname);
    if (!relation) return f.config.fetchPort(input, init);
    const name = relation[2]!, selected = name === "businesses" ? "11" : relation[1] === "22" ? "33" : "34";
    const rows = Array.from({ length: 499 }, (_, i) => ({ id: i ? String(800000 + i) : selected, ...classLink(name, i ? String(800000 + i) : selected) }));
    const page = Number(u.searchParams.get("page")); return Response.json({ [name]: rows.slice((page - 1) * 100, page * 100), total_entries: rows.length });
  };
  const proof = largest ? { verifyPatient: async (...args: Parameters<typeof f.proof.verifyPatient>) => {
    if (await claimClinikoBudget(f.config.cliniko.rateBudget)) return err({ kind: "notFound" as const, target: "patient" as const });
    return f.proof.verifyPatient(...args);
  } } : f.proof;
  const mover = resultValue(ClinikoClassAttendanceMove.create({ ...f.config, fetchPort: port, proof, proofNativeRequestFloor: largest ? 1 : 0, quotaStaging: { version } }));
  const stages = resultValue(mover.prepareStagesOnce(f.request));
  let started = false;
  const confirmation = (): ClassMoveStageConfirmation => ({ contractVersion: version, verificationRef: f.request.verificationRef, confirmationRef: randomUUID(),
    expiresAt: started ? new Date(Date.parse(f.config.clock()) + 110000).toISOString() : f.request.expiresAt });
  const advance = async (allow: ClassMoveStagePermit = async q => f.permit(q)) => {
    const auth = confirmation();
    const result = resultValue(await stages.advanceOnce(auth, f.lifetime.signal, async q => {
      assert.equal(q.confirmationRef, auth.confirmationRef); assert.equal(q.stagingContractVersion, version);
      assert.equal(q.request.expiresAt, auth.expiresAt); return allow(q);
    }));
    if (result.kind !== "waiting") started = true;
    return result;
  };
  const reset = () => f.setTime(new Date(Date.parse(f.config.clock()) + 61000).toISOString());
  return { ...f, mover, stages, confirmation, advance, reset, get claims() { return f.claims; } };
}

for (const row of [{ different: false, largest: false }, { different: true, largest: false }, { different: true, largest: true }]) test(`E2E-417 native staged movement completes larger-than-window workload ${JSON.stringify(row)}`, async t => {
  const different = row.different, f = await fixture(different, row.largest);
  try {
    const waiting = await f.advance(); assert.equal(waiting.kind, "waiting"); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    f.reset(); const counts: number[] = [];
    for (const [index, next] of ["original", "association", undefined].entries()) {
      const before = f.claims, result = await f.advance(); counts.push(f.claims - before);
      assertPublicStageProgress(result);
      assert.ok(counts.at(-1)! <= 180, JSON.stringify(counts));
      if (next) { assert.equal(result.kind, "staged"); if (result.kind === "staged") assert.equal(result.next, next); }
      else { assert.equal(result.kind, "finished"); if (result.kind === "finished") assert.equal(result.observation.kind, "moved"); }
      assert.equal(f.writes.length, index + 1);
      if (next) {
        const count: number = f.writes.length; assert.equal((await f.advance()).kind, "waiting"); assert.equal(f.writes.length, count); f.reset();
      }
    }
    assert.ok(counts.reduce((a, b) => a + b, 0) > 180, JSON.stringify(counts));
    t.diagnostic(`native phase claims: ${JSON.stringify(counts)}; total: ${counts.reduce((a, b) => a + b, 0)}`);
    assert.deepEqual(f.writes.map(w => w.leg), ["replacement", "original", "association"]);
    assert.notEqual(f.original.cancelled_at, null); assert.equal(f.recalls.length, 1);
    assert.equal((await f.stages.advanceOnce(f.confirmation(), f.lifetime.signal, f.permit)).ok, false);
    assert.equal(f.mover.prepareStagesOnce(f.request).ok, false);
    const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes)).request.operation;
    assert.ok(review.kind === "classMove" && review.pass); assert.equal(review.quotaStaging, version);
  } finally { f.lifetime.abort(); }
});

test("E2E-417 staging requires independent approval and each phase rejects stale, reused or malformed confirmation", async () => {
  const f = await fixture();
  try {
    assert.equal(resultValue(ClinikoClassAttendanceMove.create(f.config)).prepareStagesOnce(f.request).ok, false);
    assert.equal(ClinikoClassAttendanceMove.create({ ...f.config, quotaStaging: { version: "" } }).ok, false);
    assert.equal(ClinikoClassAttendanceMove.create(Object.assign(Object.create({ quotaStaging: { version } }), f.config)).ok, false);
    f.reset(); const auth = f.confirmation();
    assert.equal(resultValue(await f.stages.advanceOnce(auth, f.lifetime.signal, f.permit)).kind, "staged");
    const before = f.claims;
    for (const invalid of [auth, { ...auth, confirmationRef: randomUUID(), contractVersion: "other" },
      { ...auth, confirmationRef: randomUUID(), expiresAt: f.config.clock() },
      { ...auth, confirmationRef: randomUUID(), checkpoint: "pretend original cancelled" }]) {
      assert.equal((await f.stages.advanceOnce(invalid, f.lifetime.signal, f.permit)).ok, false);
    }
    assert.equal(f.claims, before); assert.equal(f.writes.length, 1); assert.equal(f.original.cancelled_at, null);
  } finally { f.lifetime.abort(); }
});

test("E2E-417 denied first-stage consent cannot create a review or attendance", async () => {
  const f = await fixture();
  try {
    f.reset(); const result = await f.advance(async () => false);
    assert.equal(result.kind, "finished"); assert.equal(f.recalls.length, 0); assert.equal(f.writes.length, 0);
    if (result.kind === "finished") assert.equal(result.observation.kind, "notSent");
  } finally { f.lifetime.abort(); }
});

for (const leg of ["review", "replacement", "original", "association"])
  test(`E2E-417 staged lost ${leg} response remains unresolved without replay or compensation`, async () => {
    const f = await fixture();
    try {
      f.lose(leg); f.reset(); let result = await f.advance();
      while (result.kind === "staged") { f.reset(); result = await f.advance(); }
      assert.equal(result.kind, "finished");
      if (result.kind === "finished") assert.ok(result.observation.kind === "needsReview" || result.observation.review === "uncertain");
      const count = f.writes.length;
      assert.equal(count, leg === "review" ? 0 : leg === "replacement" ? 1 : leg === "original" ? 2 : 3);
      f.reset(); assert.equal((await f.stages.advanceOnce(f.confirmation(), f.lifetime.signal, f.permit)).ok, false); assert.equal(f.writes.length, count);
    } finally { f.lifetime.abort(); }
  });

test("E2E-417 large staged compensation cancels only the replacement and separately inspects restoration", async () => {
  const f = await fixture(true);
  try {
    f.reset(); assert.equal((await f.advance()).kind, "staged"); f.deny(["cancelOriginal"]);
    for (const next of ["compensation", "compensationInspection"]) {
      f.reset(); const result = await f.advance(); assert.equal(result.kind, "staged"); if (result.kind === "staged") assert.equal(result.next, next);
      assertPublicStageProgress(result);
    }
    assert.deepEqual(f.writes.map(w => w.leg), ["replacement", "compensation"]);
    f.reset(); const result = await f.advance(); assert.equal(result.kind, "finished"); if (result.kind === "finished") assert.equal(result.observation.kind, "restored");
    assert.equal(f.original.cancelled_at, null); assert.notEqual(f.attendees.find(r => r.id === "401")!.cancelled_at, null);
    assert.equal(f.recalls.length, 1);
  } finally { f.lifetime.abort(); }
});

for (const fault of ["proof", "entitlement"] as const)
  test(`E2E-417 ${fault} withdrawal between stages cannot cancel the original or link a pass`, async () => {
    const f = await fixture();
    try {
      f.reset(); assert.equal((await f.advance()).kind, "staged");
      if (fault === "proof") f.revoke(); else f.changeEntitlement();
      f.reset(); let result = await f.advance();
      if (result.kind === "staged") { assert.equal(result.next, "compensation"); f.reset(); result = await f.advance(); }
      assert.equal(result.kind, "finished"); if (result.kind === "finished") assert.equal(result.observation.kind, "needsReview");
      assert.deepEqual(f.writes.map(w => w.leg), ["replacement"]); assert.equal(f.original.cancelled_at, null);
    } finally { f.lifetime.abort(); }
  });

test("E2E-417 staged review header cannot be downgraded to legacy authorization context", async () => {
  const f = await fixture();
  try {
    f.reset(); assert.equal((await f.advance()).kind, "staged");
    const review = f.recalls[0]!;
    assert.match(review.notes as string, /Abby staged class pass movement review v1/);
    const decoded = resultValue(decodeClinikoReview(review.notes)), request = structuredClone(decoded.request);
    assert.ok(request.operation.kind === "classMove"); Reflect.deleteProperty(request.operation, "quotaStaging");
    Object.setPrototypeOf(request.operation, { quotaStaging: version });
    assert.equal(encodeClinikoReview(decoded.marker, request).ok, false);
    assert.equal(decodeClinikoReview((review.notes as string).replace("Abby staged class pass movement review v1", "Abby class pass movement review v1")).ok, false);
  } finally { f.lifetime.abort(); }
});


test("E2E-417 clock failure before stage admission returns unavailable without native work", async () => {
  const f = await classPassMoveFixture(); let failed = false;
  try {
    const mover = resultValue(ClinikoClassAttendanceMove.create({ ...f.config, quotaStaging: { version }, clock: () => {
      if (failed) throw new Error("clock unavailable"); return f.config.clock();
    } }));
    const stages = resultValue(mover.prepareStagesOnce(f.request)); failed = true;
    const result = await stages.advanceOnce({ contractVersion: version, verificationRef: f.request.verificationRef, confirmationRef: randomUUID(), expiresAt: f.request.expiresAt }, f.lifetime.signal, f.permit);
    assert.equal(result.ok, false); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  } finally { f.lifetime.abort(); }
});


for (const fault of ["recalled", "edited", "archived"] as const)
  test(`E2E-417 ${fault} Cliniko review between phases withdraws the staged owner`, async () => {
    const f = await fixture();
    try {
      f.reset(); assert.equal((await f.advance()).kind, "staged");
      if (fault === "recalled") f.recalls[0]!.recalled = true;
      else if (fault === "edited") f.recalls[0]!.updated_at = "2026-10-07T12:00:00.000Z";
      else f.recalls[0]!.archived_at = "2026-10-07T12:00:00.000Z";
      f.reset(); const result = await f.advance(); assert.equal(result.kind, "finished");
      if (result.kind === "finished") assert.equal(result.observation.kind, "needsReview");
      assert.deepEqual(f.writes.map(w => w.leg), ["replacement"]); assert.equal(f.original.cancelled_at, null);
    } finally { f.lifetime.abort(); }
  });

test("E2E-417 review ownership loss after association prevents a completed move claim", async () => {
  const f = await fixture();
  try {
    f.onWrite(leg => { if (leg === "association") f.recalls[0]!.updated_at = "2026-10-07T12:00:00.000Z"; });
    f.reset(); await f.advance(); f.reset(); await f.advance(); f.reset(); const result = await f.advance();
    assert.equal(result.kind, "finished"); if (result.kind === "finished") assert.equal(result.observation.kind, "needsReview");
    assert.deepEqual(f.writes.map(w => w.leg), ["replacement", "original", "association"]);
  } finally { f.lifetime.abort(); }
});

test("E2E-417 concurrent advances cannot execute a pending native leg twice", async () => {
  const f = await fixture(); let ready!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { ready = resolve; }), finish = new Promise<void>(resolve => { release = resolve; });
  const raw = f.config.fetchPort;
  f.config.fetchPort = async (input, init) => {
    if (init?.method === "POST" && new URL(String(input)).pathname === "/v1/attendees") { ready(); await finish; }
    return raw(input, init);
  };
  try {
    f.reset(); const first = f.advance();
    try {
      await held; assert.equal((await f.stages.advanceOnce(f.confirmation(), f.lifetime.signal, f.permit)).ok, false);
    } finally { release(); }
    assert.equal((await first).kind, "staged"); assert.deepEqual(f.writes.map(w => w.leg), ["replacement"]);
  } finally { release(); f.lifetime.abort(); }
});

test("E2E-417 abort after a possible replacement remains uncertain and cannot resume", async () => {
  const f = await fixture(), raw = f.config.fetchPort;
  f.config.fetchPort = async (input, init) => {
    const result = await raw(input, init);
    if (init?.method === "POST" && new URL(String(input)).pathname === "/v1/attendees") f.lifetime.abort();
    return result;
  };
  try {
    f.reset(); const result = await f.advance(); assert.equal(result.kind, "finished");
    if (result.kind === "finished") assert.equal(result.observation.kind, "needsReview");
    assert.deepEqual(f.writes.map(w => w.leg), ["replacement"]); assert.equal(f.original.cancelled_at, null);
    assert.equal((await f.stages.advanceOnce(f.confirmation(), new AbortController().signal, f.permit)).ok, false);
  } finally { f.lifetime.abort(); }
});

for (const mode of ["renewed", "expired", "wrongPatient"] as const)
  test(`E2E-417 stage proof ${mode} preserves the original subject without extending an old grant`, async () => {
    const f = await classPassMoveFixture({ history: 999, rosterHistory: 201 });
    let currentRef = f.request.verificationRef, patient = "42", expiry = Date.parse(f.config.clock()) + 300000;
    const proof = { verifyPatient: async (scope: typeof f.scope, ref: string) => ref === currentRef
      ? { ok: true as const, value: { scope, patientRef: patient, verificationRef: ref, expiresAt: new Date(expiry).toISOString() } }
      : err({ kind: "notFound" as const, target: "patient" as const }) };
    const mover = resultValue(ClinikoClassAttendanceMove.create({ ...f.config, proof, quotaStaging: { version } }));
    const stages = resultValue(mover.prepareStagesOnce(f.request));
    const auth = (first = false) => ({ contractVersion: version, confirmationRef: randomUUID(), verificationRef: currentRef,
      expiresAt: first ? f.request.expiresAt : new Date(Date.parse(f.config.clock()) + 110000).toISOString() });
    const advance = async (first = false) => { const confirmation = auth(first); return resultValue(await stages.advanceOnce(confirmation, f.lifetime.signal, async q => {
      assert.equal(q.request.verificationRef, confirmation.verificationRef); return f.permit(q);
    })); };
    try {
      f.setTime("2026-10-07T10:01:01.000Z"); assert.equal((await advance(true)).kind, "staged");
      f.setTime("2026-10-07T10:03:02.000Z"); // Old five-minute proof has less than the required two-minute margin.
      if (mode !== "expired") { currentRef = "new-private-stage-proof"; expiry = Date.parse(f.config.clock()) + 300000; }
      if (mode === "wrongPatient") patient = "43";
      let result = await advance();
      if (mode === "renewed") {
        assert.equal(result.kind, "staged"); f.setTime("2026-10-07T10:04:03.000Z"); result = await advance();
        assert.equal(result.kind, "finished"); if (result.kind === "finished") assert.equal(result.observation.kind, "moved");
        assert.deepEqual(f.writes.map(w => w.leg), ["replacement", "original", "association"]);
      } else {
        assert.equal(result.kind, "finished"); if (result.kind === "finished") assert.equal(result.observation.kind, "needsReview");
        assert.deepEqual(f.writes.map(w => w.leg), ["replacement"]); assert.equal(f.original.cancelled_at, null);
      }
      assert.equal(JSON.stringify(f.recalls).includes("new-private-stage-proof"), false);
      assert.equal(JSON.stringify(f.recalls).includes(f.request.verificationRef), false);
    } finally { f.lifetime.abort(); }
  });
