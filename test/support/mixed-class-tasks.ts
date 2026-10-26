import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import type { BookingApproval } from "../../src/standalone/owner-file-booking-policy.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { classBookingFixture } from "./class-booking.ts";
import { classLink } from "./class-attendance.ts";
import { syntheticTaskSequence } from "./call-task-sequence.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export type MixedTaskKind = "class" | "individual";

/** One admitted caller and credential, with independently approved services.
 * Class writes keep the existing fixture's own confirmation/review assertions. */
export async function mixedClassTasksFixture(options: { passes?: boolean; sequence?: boolean } = {}) {
  let lostIndividual = false;
  const individualWrites: Record<string, unknown>[] = [], individualRecalls: Record<string, unknown>[] = [];
  let individualRecord: Record<string, unknown> | undefined;
  let readState: Awaited<ReturnType<typeof classBookingFixture>>["state"] | undefined;
  const f = await classBookingFixture({ ...(options.passes ? { passes: true } : {}), fetchAround: base => async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.au5.cliniko.com");
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    if (method === "GET") {
      if (url.pathname === "/v1/businesses/11") return Response.json({
        id: "11", archived_at: null, time_zone_identifier: "Australia/Sydney", show_in_online_bookings: true, appointment_type_ids: ["33", "35"],
      });
      if (url.pathname === "/v1/practitioners/22") return Response.json({ id: "22", active: true, archived_at: null,
        show_in_online_bookings: true, display_name: "Demo Practitioner" });
      if (url.pathname === "/v1/appointment_types/35") return Response.json({ id: "35", archived_at: null,
        show_in_online_bookings: true, duration_in_minutes: 30, name: "Physiotherapy" });
      if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({ practitioners: [{ id: "22", ...classLink("practitioners", "22") }], total_entries: 1 });
      if (url.pathname === "/v1/practitioners/22/appointment_types") return Response.json({ appointment_types: ["33", "35"].map(id => ({ id, ...classLink("appointment_types", id) })), total_entries: 2 });
      if (url.pathname.endsWith("/available_times")) {
        assert.ok(url.pathname.includes("/appointment_types/35/"));
        const available_times = individualRecord ? [] : [{ appointment_start: "2026-10-08T04:00:00.000Z" }];
        return Response.json({ available_times, total_entries: available_times.length });
      }
      if (url.pathname === "/v1/individual_appointments/91") return individualRecord ? Response.json(individualRecord) : new Response(null, { status: 404 });
      if (url.pathname === "/v1/individual_appointments/91/conflicts") return Response.json({ conflicts: { exist: false } });
    }
    if (method === "POST" && url.pathname === "/v1/recalls") {
      const body = JSON.parse(String(init?.body));
      const review = resultValue(decodeClinikoReview(body.notes));
      if (review.request.operation.kind === "book") {
        const row = { id: "72", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
          patient: classLink("patients", body.patient_id), recall_type: classLink("recall_types", "7") };
        individualRecalls.push(row); return Response.json(row, { status: 201 });
      }
      assert.equal(review.request.operation.kind, "classBook");
    }
    if (method === "POST" && url.pathname === "/v1/individual_appointments") {
      assert.equal(individualWrites.length, 0); assert.equal(individualRecalls.length, 1);
      const state = await readState!(), dispatched = Object.values(state.actions).filter(action => action.status === "dispatched");
      assert.equal(dispatched.length, 1);
      assert.equal(state.presentations[dispatched[0]!.presentationId]!.status, "played");
      const body = JSON.parse(String(init?.body)); assert.equal(body.appointment_type_id, "35");
      individualWrites.push(body);
      individualRecord = { id: "91", starts_at: body.starts_at,
        ends_at: new Date(Date.parse(body.starts_at) + 30 * 60_000).toISOString(), cancelled_at: null, archived_at: null, deleted_at: null, notes: body.notes,
        patient: classLink("patients", body.patient_id), business: classLink("businesses", body.business_id),
        practitioner: classLink("practitioners", body.practitioner_id), appointment_type: classLink("appointment_types", body.appointment_type_id) };
      if (lostIndividual) throw new Error("synthetic lost individual response");
      return Response.json(individualRecord, { status: 201 });
    }
    return base(value, init);
  } });
  f.host.dispose(); f.session.dispose(); readState = f.state;
  let flow: ClinikoCallFlow | undefined;
  try {
    const source = f.classSessionConfig, path = join(f.folder, "individual-booking.json");
    let individualApproval: BookingApproval = { scope: f.scope, revision: "individual-1", approverRef: f.account.actor.actorRef,
      approvedAt: "2026-10-04T05:59:00.000Z", effectiveFrom: "2026-10-04T05:59:00.000Z", effectiveUntil: "2026-10-05T06:00:00.000Z",
      approved: true, enabled: true, policyVersion: source.policyVersion, businessId: "11", practitionerId: "22", appointmentTypeId: "35",
      credentialFingerprint: f.approval.credentialFingerprint, recallTypeId: "7", timeZone: "Australia/Sydney", writeContract: "bestEffort",
      notificationOwner: "cliniko", serviceRef: "physiotherapy", bookingPolicyVersion: "individual-terms-1", durationMinutes: 30,
      minNoticeMinutes: 60, maxAdvanceDays: 30, offerTtlSeconds: 120 };
    const replaceIndividual = async (patch: Partial<BookingApproval>) => {
      individualApproval = { ...individualApproval, ...patch }; await writeFile(path, JSON.stringify(individualApproval), { mode: 0o600 });
    };
    await replaceIndividual({});
    const config: ClinikoCallFlowConfig = { ...source, cliniko: { ...source.cliniko, appointmentTypeId: "35" },
      approvals: { bookCaller: source.callerApprovalPath, cancelCaller: source.callerApprovalPath, rescheduleCaller: source.callerApprovalPath,
        booking: path, cancellation: path, rescheduling: path },
      classAttendance: { approvalPath: source.classApprovalPath, practitionerId: "22", appointmentTypeId: "33",
        bookPermission: source.classPermission, cancelPermission: source.classPermission,
        ...(options.passes ? { passAuthority: f.pass.authority } : {}) } };
    const tasks = await syntheticTaskSequence(config, f.folder);
    const flowConfig = options.sequence === false ? config : tasks.config;
    flow = resultValue(ClinikoCallFlow.create(flowConfig));
    const owner = flow, reception = new TextReception(f.ledger, f.policies, owner);
    let taskNumber = 0;
    const start = async (kind: MixedTaskKind) => {
      const before = f.mail.length;
      resultValue(await reception.startWorkflow(f.scope, f.turn(`task-${++taskNumber}`, kind === "class" ? "Book my Pilates class" : "Book another physiotherapy appointment"),
        "book", source.clock(), undefined, undefined, false, undefined, undefined, kind === "class" ? true : undefined));
      const deadline = Date.now() + 5000;
      while (f.mail.length === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(f.mail.length, before + 1); await f.play();
    };
    const propose = async () => {
      assert.equal((await owner.submitCode(f.mail.at(-1)!.code)).verified, true);
      resultValue(await reception.readBookingMenu(f.scope, f.turn("menu"), "2026-10-08", "2026-10-08", source.clock())); await f.play();
      resultValue(await reception.selectBookingMenu(f.scope, f.turn("choice"), 1, source.clock())); await f.play();
      const action = Object.values((await f.state()).actions).at(-1)!;
      assert.ok(action, "a current verified menu selection must propose an action");
      assert.equal(action.status, "awaitingConfirmation");
      return action;
    };
    const book = async () => {
      const action = await propose();
      resultValue(await reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, source.clock()));
      resultValue(await reception.drain(f.scope, f.callId, source.clock()));
      const state = await f.state();
      if (state.actions[action.key]!.status === "awaitingConfirmation") {
        const notice = state.presentations[state.pendingPresentationId!];
        assert.ok(notice?.kind === "notice" && notice.confirmationWaitSeconds);
        assert.equal(f.writes.length, 0, "the class pass quota wait cannot dispatch its earlier affirmative");
        await f.play(); await f.pause(notice.confirmationWaitSeconds + 1);
        resultValue(await reception.affirm(f.scope, f.turn("yes-after-wait", "Yes"), action.key, action.digest, source.clock()));
        resultValue(await reception.drain(f.scope, f.callId, source.clock()));
      }
      await f.play();
      return (await f.state()).actions[action.key]!;
    };
    f.bindNativeCall(f.state); await f.play();
    return { ...f, flow: owner, flowConfig, reception, tasks, start, propose, book, replaceIndividual, individualWrites, individualRecalls,
      bindMixedCall: (read: typeof f.state) => { readState = read; f.bindNativeCall(read); },
      loseIndividual: () => { lostIndividual = true; }, close: async () => { owner.dispose(); await f.close(); } };
  } catch (error) { flow?.dispose(); await f.close(); throw error; }
}
