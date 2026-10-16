import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoClassAttendanceMove, classMoveLegActionId } from "../../src/standalone/cliniko-class-attendance-move.ts";
import type { ClinikoClassMovePhase, ClinikoClassMoveRequest } from "../../src/standalone/cliniko-class-attendance-move.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { classAttendanceFixture, classNow as now, classScope, classLink as link, classAttendee as attendee, classBase as base } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

function fixture(differentService = false) {
  const scope = { ...classScope, tenantId: `class-move-${randomUUID()}` }, budget = new ClinikoReadBudget(180, () => Date.parse(now));
  let claims = 0;
  const rateBudget = { claim: () => { claims++; return budget.claim(); }, observe429: budget.observe429.bind(budget) };
  const f = classAttendanceFixture({ scope, rateBudget });
  f.groups.find(row => row.id === "94")!.starts_at = "2026-10-09T10:00:00.000Z";
  f.groups.find(row => row.id === "94")!.ends_at = "2026-10-09T11:00:00.000Z";
  if (differentService) {
    f.business.appointment_type_ids = ["33", "34"];
    Object.assign(f.groups.find(row => row.id === "94")!, { practitioner: link("practitioners", "23"), appointment_type: link("appointment_types", "34"), ends_at: "2026-10-09T10:30:00.000Z" });
  }
  const shared = structuredClone(f.groups), others = structuredClone(f.attendees.filter(row => (row.patient as { links: { self: string } }).links.self !== `${base}/patients/42`));
  const recalls: Record<string, unknown>[] = [], writes: { path: string; body: Record<string, unknown> }[] = [], phases: ClinikoClassMovePhase[] = [];
  let lost: "review" | "replacement" | "original" | "compensation" | undefined, clock = now;
  let rejectedReview = false, permit: (phase: ClinikoClassMovePhase) => boolean = () => true;
  let afterWrite: ((leg: string) => void) | undefined, beforeExact: ((path: string) => void) | undefined;
  const lifetime = new AbortController();
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (url.pathname === "/v1/recalls" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      const review = resultValue(decodeClinikoReview(body.notes));
      assert.equal(review.request.operation.kind, "classMove");
      assert.equal(review.request.patientId, "42");
      assert.equal(String(body.notes).includes("private-class-proof"), false);
      assert.equal(String(body.notes).includes("private-attendee-note"), false);
      if (rejectedReview) return new Response(null, { status: 403 });
      const row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
        patient: link("patients", body.patient_id), recall_type: link("recall_types", "7") };
      recalls.push(row);
      if (lost === "review") throw new Error("synthetic lost movement review");
      return Response.json(row, { status: 201 });
    }
    if (method === "POST" || method === "PATCH") {
      assert.equal(recalls.length, 1, "one owned movement review must precede native attendance changes");
      assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
      const body = JSON.parse(String(init?.body)); writes.push({ path: url.pathname, body });
      let leg: "replacement" | "original" | "compensation", row: Record<string, unknown>;
      if (method === "POST") {
        assert.equal(url.pathname, "/v1/attendees");
        assert.deepEqual(Object.keys(body).sort(), ["booking_id", "notes", "patient_id"]);
        assert.equal(body.booking_id, "94"); assert.equal(body.patient_id, "42");
        assert.equal(body.notes, `Abby attendance ${classMoveLegActionId(request.actionId, "replacement")}`);
        leg = "replacement"; row = { ...attendee("401", "94", "42"), notes: body.notes }; f.attendees.push(row);
      } else {
        assert.deepEqual(body, { cancellation_reason: 50, apply_to_repeats: false });
        assert.match(url.pathname, /^\/v1\/attendees\/(?:101|401)\/cancel$/);
        leg = url.pathname.includes("/101/") ? "original" : "compensation";
        row = f.attendees.find(row => row.id === (leg === "original" ? "101" : "401"))!;
        row.cancelled_at = clock; row.cancellation_reason = body.cancellation_reason;
      }
      afterWrite?.(leg);
      if (lost === leg) throw new Error("synthetic lost movement leg response");
      return method === "POST" ? Response.json(row, { status: 201 }) : new Response(null, { status: 204 });
    }
    if (/^\/v1\/attendees\/[1-9][0-9]*$/.test(url.pathname)) {
      beforeExact?.(url.pathname);
      return Response.json(f.attendees.find(row => row.id === url.pathname.split("/").at(-1)));
    }
    if (differentService) {
      if (url.pathname === "/v1/practitioners/23") return Response.json({ id: "23", active: true });
      if (url.pathname === "/v1/appointment_types/34") return Response.json({ id: "34", archived_at: null, max_attendees: 10 });
      if (url.pathname === "/v1/practitioners/23/businesses") return Response.json({ businesses: [{ id: "11", ...link("businesses", "11") }], total_entries: 1 });
      if (url.pathname === "/v1/practitioners/23/appointment_types") return Response.json({ appointment_types: [{ id: "34", ...link("appointment_types", "34") }], total_entries: 1 });
    }
    return f.fetchPort(value, init);
  };
  const config = { scope, cliniko: f.config, source: { practitionerId: "22", appointmentTypeId: "33", className: "Mat Pilates" },
    destination: differentService ? { practitionerId: "23", appointmentTypeId: "34", className: "Reformer Pilates" } : { practitionerId: "22", appointmentTypeId: "33", className: "Mat Pilates" }, proof: f.proof,
    policyVersion: "policy-1", termsVersion: "move-and-recovery-terms-1", timeZone: "Australia/Sydney", recallTypeId: "7",
    clock: () => clock, signal: lifetime.signal, fetchPort };
  const request: ClinikoClassMoveRequest = { scope, patientId: "42", verificationRef: "private-class-proof", actionId: randomUUID(),
    expiresAt: "2026-10-07T10:02:00.000Z", source: { sessionId: "91", attendeeId: "101", startsAt: "2026-10-08T10:00:00.000Z", endsAt: "2026-10-08T11:00:00.000Z" },
    destination: { sessionId: "94", startsAt: "2026-10-09T10:00:00.000Z", endsAt: differentService ? "2026-10-09T10:30:00.000Z" : "2026-10-09T11:00:00.000Z" }, cancellationReason: 50, compensation: "cancelReplacementIfOriginalUnsent" };
  const mover = resultValue(ClinikoClassAttendanceMove.create(config));
  const permission = async (query: Parameters<Parameters<typeof mover.executeOnce>[2]>[0]) => {
    phases.push(query.phase); assert.deepEqual(query.request, request);
    assert.equal(Object.isFrozen(query.request), true); assert.equal(Object.isFrozen(query.request.destination), true);
    return permit(query.phase);
  };
  const run = () => mover.executeOnce(request, lifetime.signal, permission);
  const unchanged = () => { assert.deepEqual(f.groups, shared); assert.deepEqual(f.attendees.filter(row => (row.patient as { links: { self: string } }).links.self !== `${base}/patients/42`), others); };
  return { ...f, config, request, mover, run, permission, scope, recalls, writes, phases, lifetime, unchanged, get claims() { return claims; },
    deny: (phases: ClinikoClassMovePhase[]) => { permit = phase => !phases.includes(phase); },
    rejectReview: () => { rejectedReview = true; }, lose: (leg: NonNullable<typeof lost>) => { lost = leg; },
    afterWrite: (hook: typeof afterWrite) => { afterWrite = hook; }, beforeExact: (hook: typeof beforeExact) => { beforeExact = hook; },
    setTime: (value: string) => { clock = value; } };
}

test("E2E-397 native class movement verifies the replacement before original cancellation and inspects both final occurrences", async () => {
  const f = fixture();
  const result = resultValue(await f.run());
  assert.equal(result.kind, "moved"); assert.equal(result.original, "inspectedCancelled"); assert.equal(result.replacement, "inspectedActive");
  assert.equal(result.replacementAttendeeRef, "cliniko:attendee:401"); assert.equal(result.recallRef, "cliniko:recall:71");
  assert.deepEqual(f.writes.map(row => row.path), ["/v1/attendees", "/v1/attendees/101/cancel"]);
  assert.equal(f.attendees.find(row => row.id === "101")!.cancelled_at, now);
  assert.equal(f.attendees.find(row => row.id === "401")!.cancelled_at, null);
  assert.ok(f.phases.indexOf("inspectReplacement") < f.phases.indexOf("cancelOriginal"));
  assert.equal(JSON.stringify(result).includes("private"), false); f.unchanged();
  assert.equal((await f.run()).ok, false); assert.equal(f.writes.length, 2);
});

for (const compensate of [false, true])
  test(`E2E-397 a different instructor and 30-minute class ${compensate ? "compensates under independent permission" : "moves with exact native bindings"} within the 180-request budget`, async () => {
    const f = fixture(true);
    if (compensate) f.deny(["cancelOriginal"]);
    const result = resultValue(await f.run());
    assert.equal(result.kind, compensate ? "restored" : "moved");
    assert.ok(f.claims <= 180, `physical account claims ${f.claims}`);
    const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes));
    assert.equal(review.request.operation.kind, "classMove");
    if (review.request.operation.kind !== "classMove") throw new Error("wrong movement review");
    assert.equal(review.request.operation.newPractitionerId, "23"); assert.equal(review.request.operation.newAppointmentTypeId, "34");
    assert.equal(review.request.operation.newEndsAt, "2026-10-09T10:30:00.000Z");
    assert.equal(f.attendees.find(row => row.id === "101")!.cancelled_at, compensate ? null : now);
    f.unchanged();
  });

for (const fault of ["full", "alreadyThere", "duplicateSource", "wrongSource", "sourceChanged", "destinationChanged", "proof", "permission", "reviewRejected", "reviewLost"] as const)
  test(`E2E-397 ${fault} before move cannot change either attendance`, async () => {
    const f = fixture();
    if (fault === "full") for (const index of [1, 2, 3]) f.attendees.push(attendee(String(700 + index), "94", String(800 + index)));
    if (fault === "alreadyThere") f.attendees.push(attendee("402", "94", "42"));
    if (fault === "duplicateSource") f.attendees.push(attendee("403", "91", "42"));
    if (fault === "wrongSource") (f.request.source as { attendeeId: string }).attendeeId = "102";
    if (fault === "sourceChanged") f.groups.find(row => row.id === "91")!.ends_at = "2026-10-08T11:30:00.000Z";
    if (fault === "destinationChanged") f.groups.find(row => row.id === "94")!.ends_at = "2026-10-09T11:30:00.000Z";
    if (fault === "proof") f.revoke();
    if (fault === "permission") f.deny(["review"]);
    if (fault === "reviewRejected") f.rejectReview();
    if (fault === "reviewLost") f.lose("review");
    const result = resultValue(await f.run()); assert.equal(result.kind, "notSent"); assert.equal(f.writes.length, 0);
    assert.equal(f.attendees.find(row => row.id === "101")!.cancelled_at, null);
    if (fault !== "reviewLost") assert.equal(f.recalls.length, 0);
  });

for (const leg of ["replacement", "original", "compensation"] as const)
  test(`E2E-397 unknown ${leg} response cannot replay or trigger unsafe rollback`, async () => {
    const f = fixture(); f.lose(leg);
    if (leg === "compensation") f.deny(["cancelOriginal"]);
    const result = resultValue(await f.run()); assert.equal(result.kind, "needsReview");
    assert.deepEqual(f.writes.map(row => row.path), leg === "replacement" ? ["/v1/attendees"] : leg === "original" ? ["/v1/attendees", "/v1/attendees/101/cancel"] : ["/v1/attendees", "/v1/attendees/401/cancel"]);
    if (leg !== "original") assert.equal(f.attendees.find(row => row.id === "101")!.cancelled_at, null);
    const count = f.writes.length; assert.equal((await f.run()).ok, false); assert.equal(f.writes.length, count); f.unchanged();
  });

test("E2E-397 known unsent original cancellation can compensate exactly the replacement under separate current permission", async () => {
  const f = fixture(); f.deny(["cancelOriginal"]);
  const result = resultValue(await f.run()); assert.equal(result.kind, "restored");
  assert.equal(result.original, "notSent"); assert.equal(result.replacement, "inspectedCancelled");
  assert.deepEqual(f.writes.map(row => row.path), ["/v1/attendees", "/v1/attendees/401/cancel"]);
  assert.equal(f.attendees.find(row => row.id === "101")!.cancelled_at, null); f.unchanged();
});

test("E2E-397 capacity lost after replacement creation cancels only that replacement and preserves the original", async () => {
  const f = fixture(); f.afterWrite(leg => {
    if (leg === "replacement") for (const index of [1, 2, 3]) f.attendees.push(attendee(String(700 + index), "94", String(800 + index)));
  });
  const result = resultValue(await f.run()); assert.equal(result.kind, "restored");
  assert.equal(f.writes.at(-1)!.path, "/v1/attendees/401/cancel"); assert.equal(f.attendees.find(row => row.id === "101")!.cancelled_at, null);
});

for (const fault of ["replacementInspection", "compensationPermission", "compensationInspection", "originalInspection", "finalPermission", "finalDrift", "disconnect"] as const)
  test(`E2E-397 ${fault} after possible movement remains unresolved and never invents a complete move`, async () => {
    const f = fixture();
    if (fault === "replacementInspection") f.deny(["inspectReplacement"]);
    if (fault === "compensationPermission") f.deny(["cancelOriginal", "compensateReplacement"]);
    if (fault === "compensationInspection") f.deny(["cancelOriginal", "inspectCompensation"]);
    if (fault === "originalInspection") f.deny(["inspectOriginal"]);
    if (fault === "finalPermission") f.deny(["final"]);
    if (fault === "finalDrift") f.afterWrite(leg => { if (leg === "original") f.attendees.find(row => row.id === "401")!.booking = link("bookings", "93"); });
    if (fault === "disconnect") f.afterWrite(leg => { if (leg === "replacement") f.lifetime.abort(); });
    const result = resultValue(await f.run()); assert.equal(result.kind, "needsReview");
    const count = f.writes.length; assert.equal((await f.run()).ok, false); assert.equal(f.writes.length, count);
    assert.ok(count >= 1 && count <= 2);
    if (["replacementInspection", "compensationPermission", "compensationInspection", "disconnect"].includes(fault)) assert.equal(f.attendees.find(row => row.id === "101")!.cancelled_at, null);
  });

test("E2E-397 concurrent moves reserve the root action before any permission or native IO", async () => {
  const f = fixture(), results = await Promise.all([f.run(), f.run()]);
  assert.equal(results.filter(row => row.ok && row.value.kind === "moved").length, 1);
  assert.equal(results.filter(row => !row.ok && row.error.kind === "attemptConsumed").length, 1); assert.equal(f.writes.length, 2);
});

for (const stage of ["review", "bookReplacement", "cancelOriginal", "compensateReplacement", "inspectCompensation", "final"] as const)
  test(`E2E-397 ${stage} authority withdrawn during native snapshots cannot authorise a later send or confirmation`, async () => {
    const f = fixture();
    const compensation = stage === "compensateReplacement" || stage === "inspectCompensation";
    if (compensation) f.deny(["cancelOriginal"]);
    const withdrawAt = stage === "review" ? 2 : stage === "bookReplacement" ? 4 : stage === "cancelOriginal" || stage === "compensateReplacement" ? 6 : 8;
    f.onRead((path, count) => {
      if (path === "/v1/group_appointments/94" && count === withdrawAt) f.deny(compensation ? ["cancelOriginal", stage] : [stage]);
    });
    const result = resultValue(await f.run());
    assert.equal(result.kind, stage === "review" || stage === "bookReplacement" ? "notSent" : stage === "cancelOriginal" ? "restored" : "needsReview");
    if (stage === "review") assert.equal(f.recalls.length, 0);
    if (stage === "review" || stage === "bookReplacement") assert.equal(f.writes.length, 0);
    if (stage === "cancelOriginal" || stage === "compensateReplacement") assert.equal(f.writes.some(row => row.path === "/v1/attendees/101/cancel"), false);
    if (stage === "compensateReplacement") assert.equal(f.writes.some(row => row.path === "/v1/attendees/401/cancel"), false);
  });

test("E2E-397 aborted pending authority cannot start a late native movement or replay its root", { timeout: 5000 }, async () => {
  const f = fixture(), controller = new AbortController();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const timer = setTimeout(() => controller.abort(), 25);
  try {
    const result = resultValue(await f.mover.executeOnce(f.request, controller.signal, async () => { await pending; return true; }));
    assert.equal(result.kind, "notSent"); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.writes.length, 0); assert.equal((await f.run()).ok, false);
  } finally { clearTimeout(timer); release(); }
});

for (const fault of ["sameSession", "expired", "differentPatient", "wrongScope", "sameMarker", "invalidRecovery"] as const)
  test(`E2E-397 ${fault} cannot manufacture a valid movement`, async () => {
    const f = fixture();
    if (fault === "sameSession") (f.request.destination as { sessionId: string }).sessionId = "91";
    if (fault === "expired") f.setTime(f.request.expiresAt);
    if (fault === "differentPatient") (f.request as { patientId: string }).patientId = "999";
    if (fault === "wrongScope") (f.request.scope as { tenantId: string }).tenantId = "other";
    if (fault === "sameMarker") (f.request as { actionId: string }).actionId = "caller-selected";
    if (fault === "invalidRecovery") (f.request as unknown as { compensation: string }).compensation = "alwaysRollback";
    const result = await f.run(); assert.ok(!result.ok || result.value.kind === "notSent");
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  });
