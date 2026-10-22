import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { CallState } from "../../src/core/model.ts";
import type { ReschedulingApproval } from "../../src/standalone/owner-file-rescheduling-policy.ts";
import type { BookingApproval } from "../../src/standalone/owner-file-booking-policy.ts";
import type { CancellationApproval } from "../../src/standalone/owner-file-cancellation-policy.ts";
import { incomingCallContextFixture } from "./incoming-call-context.ts";
import { incomingCallFlowFixture } from "./incoming-call-flow.ts";
import { value } from "./outbound-records.ts";

/** Real incoming enquiry -> new operation code -> exact reviewed cancellation.
 * Provider/native/mail/policy grants are synthetic; no clinic activation. Native
 * campaign target precision is retained instead of replacing it with test data. */
export async function incomingClinicalCallFlowFixture(options: { snapshot?: "populated" | "empty" | "conflicting"; physical?: boolean; unanswered?: boolean; lostWrite?: boolean; rescheduling?: boolean; patientId?: string; campaignPatientId?: string; lookBackMs?: number; budget?: ClinikoRequestBudget } = {}) {
  assert.ok(!(options.physical && options.budget), "Choose the fixed source budget or an independently supplied native budget");
  const now = "2026-11-01T10:05:00.000Z", physical = new ClinikoReadBudget(180, () => Date.parse(now));
  let accepted = 0, denied = 0;
  const budget = { claim: () => { const r = physical.claim(); r === null ? accepted++ : denied++; return r; },
    observe429: physical.observe429.bind(physical), checkHeadroom: physical.checkHeadroom.bind(physical), withReservation: physical.withReservation.bind(physical) };
  const f = await incomingCallContextFixture({ sickDay: true, nativeRequestCosts: true, ...(options.budget ? { budget: options.budget } : options.physical ? { budget } : {}),
    ...(options.patientId ? { patientId: options.patientId } : {}), ...(options.campaignPatientId ? { campaignPatientId: options.campaignPatientId } : {}) });
  try {
    if (options.lookBackMs !== undefined) f.provision.lookBackMs = options.lookBackMs;
    if (options.unanswered) f.replaceWithUnanswered();
    await f.replaceApproval({ operations: ["appointments.read", "appointments.cancel", ...(options.rescheduling ? ["appointments.reschedule" as const] : [])] });
    const path = join(f.folder, "incoming-original-cancellation.json");
    const approval: CancellationApproval = { scope: f.scope, revision: "incoming-original-cancel-1", approverRef: f.approval.approverRef,
      approvedAt: f.approval.approvedAt, effectiveFrom: f.approval.effectiveFrom, effectiveUntil: f.approval.effectiveUntil,
      approved: true, enabled: true, policyVersion: f.sessionConfig.policyVersion, businessId: "11", recallTypeId: "7",
      credentialFingerprint: f.attempt.credentialFingerprint, timeZone: "Australia/Sydney", writeContract: "bestEffort", notificationOwner: "cliniko",
      cancellationReason: 50, lateNoticeHours: 24, maxAdvanceDays: 30,
      standardTerms: { version: "incoming-standard-1", approvedText: "There is no fee for this cancellation." },
      lateTerms: { version: "incoming-late-1", approvedText: "A cancellation fee of $20 applies." } };
    await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
    const movePath = join(f.folder, "incoming-original-move.json"), destinationPath = join(f.folder, "incoming-original-destination.json");
    const { cancellationReason: _cancel, ...common } = approval;
    const moveApproval: ReschedulingApproval = { ...common, revision: "incoming-original-move-1",
      standardTerms: { version: "incoming-move-standard-1", approvedText: "No fee applies to this move." },
      lateTerms: { version: "incoming-move-late-1", approvedText: "A late rescheduling fee of $40 applies." } };
    const { standardTerms: _standard, lateTerms: _late, lateNoticeHours: _notice, ...destination } = common;
    const destinationApproval: BookingApproval = { ...destination, practitionerId: "31", appointmentTypeId: "41", serviceRef: "physiotherapy",
      bookingPolicyVersion: "incoming-destination-1", durationMinutes: 30, minNoticeMinutes: 60, offerTtlSeconds: 120 };
    if (options.rescheduling) {
      await writeFile(movePath, JSON.stringify(moveApproval), { mode: 0o600 });
      await writeFile(destinationPath, JSON.stringify(destinationApproval), { mode: 0o600 });
    }
    const moveStarts = ["2026-11-03T00:00:00.000Z", "2026-11-03T01:00:00.000Z"];
    const earlier: Record<string, unknown> = { ...structuredClone(f.target.row), id: "70", links: { self: "https://api.au5.cliniko.com/v1/individual_appointments/70" },
      starts_at: "2026-11-02T09:00:00.000001+11:00", ends_at: "2026-11-02T09:30:00.000001+11:00" };
    const moves: { id: string; startsAt: string }[] = [];
    const traffic: { method: string; path: string }[] = [], writes: string[] = [], reviews: Record<string, unknown>[] = [];
    let nativeCall: (() => Promise<CallState>) | undefined;
    const currentNativeCall = () => nativeCall ? nativeCall() : f.ledger.read(f.callId, f.scope).then(value);
    const fetchPort: typeof fetch = async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? "GET";
      assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.ok(init); assert.equal(init.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from(`${f.native.config.apiKey}:`).toString("base64")}`);
      traffic.push({ method, path: url.pathname });
      if (options.rescheduling) {
        if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", archived_at: null, time_zone_identifier: "Australia/Sydney",
          show_in_online_bookings: true, appointment_type_ids: ["41"] });
        if (url.pathname === "/v1/practitioners/31") return Response.json({ id: "31", archived_at: null, active: true, show_in_online_bookings: true, display_name: "Demo Practitioner" });
        if (url.pathname === "/v1/appointment_types/41") return Response.json({ id: "41", archived_at: null, show_in_online_bookings: true, name: "Physiotherapy", duration_in_minutes: 30 });
        if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1, practitioners: [{ id: "31" }] });
        if (url.pathname === "/v1/practitioners/31/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: "41" }] });
        if (/^\/v1\/individual_appointments\/(70|71)\/conflicts$/.test(url.pathname)) return Response.json({ conflicts: { exist: false } });
        if (url.pathname.endsWith("/available_times")) return Response.json({ total_entries: moveStarts.length,
          available_times: moveStarts.map(appointment_start => ({ appointment_start })) });
        if (/^\/v1\/individual_appointments\/(70|71)$/.test(url.pathname) && method === "PATCH") {
          const body = JSON.parse(String(init.body)), id = url.pathname.split("/").at(-1)!;
          assert.equal(body.ends_at, null); assert.ok(moveStarts.includes(body.starts_at));
          const state = await currentNativeCall(), action = Object.values(state.actions).at(-1)!;
          assert.equal(action.status, "dispatched"); assert.equal(state.presentations[action.presentationId]?.status, "played");
          writes.push(id); moves.push({ id, startsAt: body.starts_at });
          Object.assign(id === "71" ? f.target.row : earlier, { starts_at: body.starts_at,
            ends_at: new Date(Date.parse(body.starts_at) + 1_800_000).toISOString(), updated_at: now });
          if (options.lostWrite) throw Error("Synthetic incoming original move response lost");
          return Response.json(id === "71" ? f.target.row : earlier);
        }
      }
      if (url.pathname === "/v1/individual_appointments") {
        const candidates = options.snapshot === "empty" ? [] : options.snapshot === "conflicting" ? [earlier] : [earlier, f.target.row];
        const patientFilter = url.searchParams.getAll("q[]").find(v => v.startsWith("patient_id:="));
        assert.ok(patientFilter);
        const rows = candidates.filter(r => (r.patient as { links: { self: string } }).links.self === `https://api.au5.cliniko.com/v1/patients/${patientFilter.slice("patient_id:=".length)}`);
        return Response.json({ individual_appointments: rows, total_entries: rows.length });
      }
      if (url.pathname === "/v1/individual_appointments/71" && method === "GET") return f.target.port(input, init);
      if (url.pathname === "/v1/individual_appointments/70" && method === "GET") return Response.json(earlier);
      if (url.pathname.endsWith("/cancel") && method === "PATCH") {
        assert.equal(JSON.parse(String(init.body)).cancellation_reason, 50);
        const state = await currentNativeCall(), action = Object.values(state.actions).at(-1)!;
        assert.equal(action.status, "dispatched"); assert.equal(state.presentations[action.presentationId]?.status, "played");
        const id = url.pathname.split("/").at(-2)!; writes.push(id);
        (id === "71" ? f.target.row : earlier).cancelled_at = now;
        if (options.lostWrite) throw Error("Synthetic incoming original cancellation response lost");
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/v1/recalls" && method === "POST") {
        const body = JSON.parse(String(init.body)); assert.equal(body.patient_id, f.attempt.patientId); assert.equal(body.recall_type_id, "7");
        reviews.push(body); const row = f.add(String(80 + reviews.length), "7", body.notes, now); row.recall_at = body.recall_at;
        return Response.json(row, { status: 201 });
      }
      if (url.pathname === "/v1/recalls" && method === "GET") {
        const filters = url.searchParams.getAll("q[]");
        assert.ok(/^patient_id:=[1-9][0-9]*$/.test(filters[0]!) && filters.length <= 2);
        if (filters.length === 2) assert.equal(filters[1], "archived_at:*");
        const rows = [...f.native.rows.values()].filter(r =>
          (r.patient as { links: { self: string } }).links.self === `https://api.au5.cliniko.com/v1/patients/${filters[0]!.slice("patient_id:=".length)}` &&
          (filters.length === 2 || r.archived_at === null)).sort((a, b) => Number(a.id) - Number(b.id));
        const page = Number(url.searchParams.get("page")), perPage = Number(url.searchParams.get("per_page"));
        return Response.json({ recalls: rows.slice((page - 1) * perPage, page * perPage), total_entries: rows.length });
      }
      if (url.pathname.startsWith("/v1/recalls/")) {
        const row = f.native.rows.get(url.pathname.split("/").at(-1)!);
        return row ? Response.json(row) : new Response(null, { status: 404 });
      }
      return f.fetchPort(input, init);
    };
    const c = await incomingCallFlowFixture(f, { fetchPort, approvals: { bookCaller: "disabled", booking: options.rescheduling ? destinationPath : "disabled",
      cancelCaller: f.path, cancellation: path, rescheduleCaller: options.rescheduling ? f.path : "disabled", rescheduling: options.rescheduling ? movePath : "disabled" } });
    const callState = async () => value(await f.ledger.read(f.callId, f.scope));
    const play = async () => { const state = await callState(); assert.ok(state.pendingPresentationId);
      value(await f.runtime.startPresentation(f.callId, state.pendingPresentationId, f.sessionId, now));
      value(await f.runtime.resolvePresentation(f.callId, state.pendingPresentationId, "played", f.sessionId, now));
    };
    const seedAccepted = accepted;
    return { ...f, ...c, now, path, approval, earlier, traffic, writes, moves, moveStarts, movePath, destinationPath, moveApproval, destinationApproval, reviews, physical, seedAccepted, callState, play,
      bindNativeCall: (read: () => Promise<CallState>) => { nativeCall = read; },
      get accepted() { return accepted; }, get denied() { return denied; },
      close: async () => { c.close(); await f.close(); } };
  } catch (e) { await f.close(); throw e; }
}
