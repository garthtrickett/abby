import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { ClinikoClassAttendanceMove, classMoveLegActionId } from "../../src/standalone/cliniko-class-attendance-move.ts";
import type { ClinikoClassMovePhase, ClinikoClassMoveRequest } from "../../src/standalone/cliniko-class-attendance-move.ts";
import { ClinikoClassPassMovement } from "../../src/standalone/cliniko-class-pass-movement.ts";
import type { ClassPassMoveAuthority } from "../../src/standalone/cliniko-class-pass-movement.ts";
import { classAttendanceFixture, classAttendee as attendee, classLink as link, classNow as initialNow, classScope } from "./class-attendance.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export async function classPassMoveFixture(options: { differentService?: boolean; differentCase?: boolean; effect?: "releaseOne" | "unchanged" | "consumeOne"; full?: boolean } = {}) {
  let now = initialNow, claims = 0;
  const budget = new ClinikoReadBudget(180, () => Date.parse(now));
  const rateBudget = { claim: () => { claims++; return budget.claim(); }, observe429: budget.observe429.bind(budget), checkHeadroom: budget.checkHeadroom.bind(budget) };
  const scope = { ...classScope, tenantId: `pass-move-${randomUUID()}` }, f = classAttendanceFixture({ scope, rateBudget });
  const sourceCaseId = "811222333444555666", destinationCaseId = options.differentCase ? "811222333444555667" : sourceCaseId;
  const effect = options.effect ?? "releaseOne", original = f.attendees.find(row => row.id === "101")!;
  Object.assign(original, { patient_case: link("patient_cases", sourceCaseId), arrived: effect === "consumeOne" ? false : null });
  f.attendees.push({ ...attendee("601", "701", "42"), patient_case: link("patient_cases", sourceCaseId), arrived: true });
  if (options.differentCase) f.attendees.push({ ...attendee("602", "702", "42"), patient_case: link("patient_cases", destinationCaseId), arrived: true });
  const records: Record<string, Record<string, unknown>> = {};
  for (const caseId of new Set([sourceCaseId, destinationCaseId])) records[caseId] = { id: caseId, ...link("patient_cases", caseId), patient: link("patients", "42"),
    max_sessions: options.full ? caseId === sourceCaseId ? effect === "consumeOne" ? 1 : 2 : 1 : 5,
    include_cancelled_attendees: caseId === sourceCaseId && effect !== "releaseOne", include_dna_attendees: false,
    issue_date: "2026-10-01", expiry_date: "2026-10-30", closed_at: null, archived_at: null,
    name: "synthetic-private-pass-name", notes: "synthetic-private-pass-notes-and-referral" };
  const caseOf = (row: Record<string, unknown>) => (row.patient_case as { links?: { self?: string } } | undefined)?.links?.self?.split("/").at(-1);
  const caseRows = (caseId: string) => f.attendees.filter(row => caseOf(row) === caseId);
  const used = (caseId: string) => caseRows(caseId).filter(row => row.archived_at === null && row.deleted_at === null &&
    (row.cancelled_at !== null ? records[caseId]!.include_cancelled_attendees : row.arrived === false ? records[caseId]!.include_dna_attendees : true)).length;
  const destination = f.groups.find(row => row.id === "94")!;
  Object.assign(destination, { starts_at: "2026-10-09T10:00:00.000Z", ends_at: options.differentService ? "2026-10-09T10:30:00.000Z" : "2026-10-09T11:00:00.000Z",
    ...(options.differentService ? { practitioner: link("practitioners", "23"), appointment_type: link("appointment_types", "34") } : {}) });
  if (options.differentService) f.business.appointment_type_ids = ["33", "34"];
  let independent = true, sourceEntitlement = "source-entitlement", destinationEntitlement = "destination-entitlement";
  const authorityQueries: unknown[] = [];
  const authority: ClassPassMoveAuthority = {
    select: async query => { authorityQueries.push(query.phase); return independent ? { source: { patientCaseId: sourceCaseId, entitlementRef: sourceEntitlement }, destination: { patientCaseId: destinationCaseId, entitlementRef: destinationEntitlement } } : undefined; },
    allows: async query => independent && query.stagingContractVersion === "unlinked-recovery-v1" && query.patientId === "42" && query.binding.source.effect === effect,
  };
  const recalls: Record<string, unknown>[] = [], writes: { path: string; body: Record<string, unknown>; leg: string }[] = [], phases: ClinikoClassMovePhase[] = [];
  let lost: string | undefined, allowed: (phase: ClinikoClassMovePhase) => boolean = () => true, onWrite = (_leg: string) => {}, onRead = (_path: string) => {};
  const fetchPort: typeof fetch = async (value, init) => {
    const u = new URL(String(value)), method = init?.method ?? "GET"; assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    if (u.pathname === "/v1/recalls" && method === "POST") {
      const body = JSON.parse(String(init?.body)), review = resultValue(decodeClinikoReview(body.notes));
      assert.equal(review.request.operation.kind, "classMove"); assert.match(String(body.notes), /Abby class pass movement review v1/);
      const row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes, patient: link("patients", "42"), recall_type: link("recall_types", "7") };
      recalls.push(row); if (lost === "review") throw new Error("synthetic lost review"); return Response.json(row, { status: 201 });
    }
    if (method === "POST" || method === "PATCH") {
      assert.equal(recalls.length, 1); const body = JSON.parse(String(init?.body));
      const leg = method === "POST" ? "replacement" : u.pathname === "/v1/attendees/401" ? "association" : u.pathname.includes("/101/") ? "original" : "compensation";
      writes.push({ path: u.pathname, body, leg }); let row: Record<string, unknown>;
      if (leg === "replacement") {
        assert.equal(u.pathname, "/v1/attendees"); assert.deepEqual(Object.keys(body).sort(), ["booking_id", "notes", "patient_id"]);
        row = { ...attendee("401", body.booking_id, body.patient_id), arrived: null, notes: body.notes }; f.attendees.push(row);
      } else if (leg === "association") {
        assert.deepEqual(body, { patient_case_id: destinationCaseId });
        assert.notEqual(original.cancelled_at, null, "association follows an inspected original cancellation");
        if (used(destinationCaseId) >= Number(records[destinationCaseId]!.max_sessions)) return Response.json({ errors: { patient_case_id: "full" } }, { status: 422 });
        row = f.attendees.find(row => row.id === "401")!; row.patient_case = link("patient_cases", body.patient_case_id);
      } else {
        assert.deepEqual(body, { cancellation_reason: 50, apply_to_repeats: false });
        row = f.attendees.find(row => row.id === (leg === "original" ? "101" : "401"))!; row.cancelled_at = now; row.cancellation_reason = body.cancellation_reason;
      }
      onWrite(leg); if (lost === leg) throw new Error("synthetic lost pass movement leg");
      return leg === "replacement" ? Response.json(row, { status: 201 }) : leg === "association" ? Response.json(row) : new Response(null, { status: 204 });
    }
    onRead(u.pathname);
    if (u.pathname.startsWith("/v1/patient_cases/")) {
      const caseId = u.pathname.split("/")[3]!, rows = caseRows(caseId).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      assert.ok(records[caseId]);
      return u.pathname.endsWith("/attendees") ? Response.json({ attendees: rows, total_entries: rows.length }) : Response.json({ ...records[caseId], attendee_ids: rows.map(row => row.id) });
    }
    if (u.pathname === "/v1/attendees" && u.searchParams.getAll("q[]").includes("patient_case_id:!?")) {
      const filters = u.searchParams.getAll("q[]");
      assert.deepEqual(filters, ["id:=401", "patient_id:=42", "booking_id:=94", "patient_case_id:!?", ...(filters.includes("cancelled_at:*") ? ["cancelled_at:*"] : [])]);
      const rows = f.attendees.filter(row => row.id === "401" && !caseOf(row) && (row.cancelled_at === null || filters.includes("cancelled_at:*")));
      return Response.json({ attendees: rows, total_entries: rows.length });
    }
    if (/^\/v1\/attendees\/\d+$/.test(u.pathname)) return Response.json(f.attendees.find(row => row.id === u.pathname.split("/").at(-1)));
    if (options.differentService) {
      if (u.pathname === "/v1/practitioners/23") return Response.json({ id: "23", active: true });
      if (u.pathname === "/v1/appointment_types/34") return Response.json({ id: "34", archived_at: null, max_attendees: 10 });
      if (u.pathname === "/v1/practitioners/23/businesses") return Response.json({ businesses: [{ id: "11", ...link("businesses", "11") }], total_entries: 1 });
      if (u.pathname === "/v1/practitioners/23/appointment_types") return Response.json({ appointment_types: [{ id: "34", ...link("appointment_types", "34") }], total_entries: 1 });
    }
    return f.fetchPort(value, init);
  };
  const lifetime = new AbortController(), config = { scope, cliniko: f.config, source: { practitionerId: "22", appointmentTypeId: "33", className: "Mat Pilates" },
    destination: options.differentService ? { practitionerId: "23", appointmentTypeId: "34", className: "Reformer Pilates" } : { practitionerId: "22", appointmentTypeId: "33", className: "Mat Pilates" },
    proof: f.proof, policyVersion: "policy-1", termsVersion: "pass-move-terms-1", timeZone: "Australia/Sydney", recallTypeId: "7", clock: () => now, signal: lifetime.signal, fetchPort,
    casePass: { authority, stagingContractVersion: "unlinked-recovery-v1" } };
  const request: ClinikoClassMoveRequest = { scope, patientId: "42", verificationRef: "private-class-proof", actionId: randomUUID(), expiresAt: "2026-10-07T10:02:00.000Z",
    source: { sessionId: "91", attendeeId: "101", startsAt: "2026-10-08T10:00:00.000Z", endsAt: "2026-10-08T11:00:00.000Z" },
    destination: { sessionId: "94", startsAt: String(destination.starts_at), endsAt: String(destination.ends_at) }, cancellationReason: 50, compensation: "cancelReplacementIfOriginalUnsent" };
  const passes = new ClinikoClassPassMovement({ ...config, ...config.casePass });
  const binding = await passes.select(request, "proposal", lifetime.signal);
  if (binding) (request as { pass: NonNullable<ClinikoClassMoveRequest["pass"]> }).pass = binding;
  const mover = resultValue(ClinikoClassAttendanceMove.create(config));
  const permit = async (query: Parameters<Parameters<typeof mover.executeOnce>[2]>[0]) => { phases.push(query.phase); return allowed(query.phase); };
  const run = () => mover.executeOnce(request, lifetime.signal, permit);
  return { ...f, config, request, mover, passes, binding, run, permit, scope, records, original, used, sourceCaseId, destinationCaseId, authorityQueries, recalls, writes, phases, lifetime,
    get claims() { return claims; }, deny: (blocked: ClinikoClassMovePhase[]) => { allowed = phase => !blocked.includes(phase); },
    denyPass: () => { independent = false; }, changeEntitlement: () => { destinationEntitlement = "changed-entitlement"; sourceEntitlement = "changed-source-entitlement"; },
    lose: (leg: string) => { lost = leg; }, onWrite: (hook: typeof onWrite) => { onWrite = hook; }, onRead: (hook: typeof onRead) => { onRead = hook; },
    setTime: (value: string) => { now = value; }, classMoveLegActionId };
}
