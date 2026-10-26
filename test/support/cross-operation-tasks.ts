import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionState } from "../../src/core/model.ts";
import { err } from "../../src/core/model.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { bookingCallFlowFixture } from "./cliniko-call-flow.ts";
import { syntheticMultiTaskBookingProvider, syntheticTaskSequence } from "./call-task-sequence.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "./caller-verification.ts";

export type CrossOperation = "book" | "cancel" | "reschedule";

/** One native-shaped account stores each appointment across all three operations. */
function appointmentProvider(clock: () => string, dispatched: (operation: CrossOperation) => Promise<void>) {
  const bookings = syntheticMultiTaskBookingProvider(), reviews: Record<string, unknown>[] = [];
  const traffic: string[] = [];
  const mutations: { operation: CrossOperation; path: string; body: Record<string, unknown> }[] = [];
  const base = "https://api.au5.cliniko.com/v1", link = (family: string, id: string) => ({ links: { self: `${base}/${family}/${id}` } });
  let lose = false;
  for (const [id, hour] of [["201", "08"], ["202", "09"]]) bookings.rows.set(id!, { id, starts_at: `2026-10-08T${hour}:00:00.000Z`,
    ends_at: `2026-10-08T${hour}:30:00.000Z`, cancelled_at: null, archived_at: null, deleted_at: null, notes: "synthetic existing appointment",
    patient: link("patients", verificationCanaries[2]!), business: link("businesses", "11"), practitioner: link("practitioners", "22"), appointment_type: link("appointment_types", "33") });
  const wrap = (underlying: typeof fetch): typeof fetch => {
    const bookingPort = bookings.wrap(underlying);
    return async (value, init) => {
      const url = new URL(String(value)), method = init?.method ?? "GET";
      traffic.push(`${method} ${url.pathname}`);
      assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
      if (url.pathname === "/v1/recalls") {
        if (method === "GET") return Response.json({ recalls: reviews, total_entries: reviews.length });
        assert.equal(method, "POST"); const body = JSON.parse(String(init?.body));
        const row = { id: String(701 + reviews.length), archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
          patient: link("patients", body.patient_id), recall_type: link("recall_types", body.recall_type_id) };
        reviews.push(row); return Response.json(row, { status: 201 });
      }
      if (method === "GET" && url.pathname === "/v1/individual_appointments") {
        assert.ok(url.searchParams.getAll("q[]").includes(`patient_id:=${verificationCanaries[2]}`));
        const appointments = [...bookings.rows.values()].filter(row => row.cancelled_at === null);
        return Response.json({ individual_appointments: appointments, total_entries: appointments.length });
      }
      if (method === "GET" && url.pathname.endsWith("/available_times")) {
        const response = await underlying(value, init), body = await response.json();
        body.available_times = body.available_times.filter((time: { appointment_start: string }) =>
          ![...bookings.rows.values()].some(row => row.cancelled_at === null && row.starts_at === time.appointment_start));
        body.total_entries = body.available_times.length; return Response.json(body, { status: response.status });
      }
      const id = /^\/v1\/individual_appointments\/(\d+)(?:\/cancel)?$/.exec(url.pathname)?.[1];
      if (method === "PATCH" && id && bookings.rows.has(id)) {
        const operation = url.pathname.endsWith("/cancel") ? "cancel" : "reschedule", body = JSON.parse(String(init?.body));
        await dispatched(operation); mutations.push({ operation, path: url.pathname, body });
        assert.equal(reviews.length, mutations.length);
        const row = bookings.rows.get(id)!;
        if (operation === "cancel") { assert.deepEqual(body, { cancellation_note: null, cancellation_reason: 50, apply_to_repeats: false }); row.cancelled_at = clock(); row.cancellation_reason = 50; }
        else { assert.deepEqual(Object.keys(body).sort(), ["ends_at", "starts_at"]); assert.equal(body.ends_at, null);
          row.starts_at = body.starts_at; row.ends_at = new Date(Date.parse(body.starts_at) + 30 * 60_000).toISOString(); }
        if (lose) throw new Error("synthetic lost change response");
        return operation === "cancel" ? new Response(null, { status: 204 }) : Response.json(row);
      }
      if (method === "POST" && url.pathname === "/v1/individual_appointments") {
        await dispatched("book"); mutations.push({ operation: "book", path: url.pathname, body: JSON.parse(String(init?.body)) });
        assert.equal(reviews.length, mutations.length);
        if (lose) bookings.loseResponse();
      }
      return bookingPort(value, init);
    };
  };
  return { wrap, rows: bookings.rows, reviews, mutations, traffic, loseResponse: () => { lose = true; } };
}

export async function crossOperationTasksFixture() {
  let now = verificationNow, state: (() => Promise<import("../../src/core/model.ts").CallState>) | undefined;
  const budget = new ClinikoReadBudget(200, () => Date.parse(now));
  const native = appointmentProvider(() => now, async operation => {
    const current = await state!(), active = Object.values(current.actions).filter(action => action.status === "dispatched");
    assert.equal(active.length, 1); assert.equal(active[0]!.kind, operation);
    assert.equal(current.presentations[active[0]!.presentationId]!.status, "played");
  });
  const f = await bookingCallFlowFixture({ appointmentChanges: true, budget, fetchAround: native.wrap }); f.flow.dispose(); state = f.state;
  let flow: ClinikoCallFlow | undefined;
  try {
    const caller = JSON.parse(await readFile(f.flowConfig.approvals.bookCaller, "utf8"));
    const cancelCaller = join(f.folder, "cancel-caller.json"), moveCaller = join(f.folder, "move-caller.json");
    await writeFile(cancelCaller, JSON.stringify({ ...caller, operations: ["appointments.cancel"] }), { mode: 0o600 });
    await writeFile(moveCaller, JSON.stringify({ ...caller, operations: ["appointments.reschedule"] }), { mode: 0o600 });
    const common = Object.fromEntries(["scope", "revision", "approverRef", "approvedAt", "effectiveFrom", "effectiveUntil", "approved", "enabled",
      "policyVersion", "businessId", "credentialFingerprint", "recallTypeId", "timeZone", "writeContract", "notificationOwner"].map(key => [key, f.approval[key as keyof typeof f.approval]]));
    const cancelPath = join(f.folder, "cancel.json"), movePath = join(f.folder, "move.json");
    const terms = (operation: string) => ({ ...common, lateNoticeHours: 24, maxAdvanceDays: 30,
      standardTerms: { version: `${operation}-normal`, approvedText: "No fee applies to this change." },
      lateTerms: { version: `${operation}-late`, approvedText: "A late change fee applies." } });
    await writeFile(cancelPath, JSON.stringify({ ...terms("cancel"), cancellationReason: 50 }), { mode: 0o600 });
    await writeFile(movePath, JSON.stringify(terms("move")), { mode: 0o600 });
    const sequence = await syntheticTaskSequence({ ...f.flowConfig, approvals: { ...f.flowConfig.approvals,
      cancelCaller, rescheduleCaller: moveCaller, cancellation: cancelPath, rescheduling: movePath } }, f.folder);
    flow = resultValue(ClinikoCallFlow.create(sequence.config)); const owner = flow;
    const reception = new TextReception(f.ledger, f.policies, owner, undefined, {
      list: (...args) => owner.appointments?.list(...args) ?? Promise.resolve(err({ kind: "unavailable" as const })),
      select: (...args) => owner.appointments?.select(...args) ?? Promise.resolve(err({ kind: "unavailable" as const })),
    }, undefined, undefined, () => now);
    const play = async () => { const pending = (await f.state()).pendingPresentationId; if (!pending) return;
      resultValue(await f.runtime.startPresentation(f.callId, pending, f.sessionId, now));
      resultValue(await f.runtime.resolvePresentation(f.callId, pending, "played", f.sessionId, now)); };
    let task = 0;
    const turn = (id: string, text = id) => f.turn(`task-${task}-${id}`, text);
    const start = async (operation: CrossOperation) => {
      const count = f.mail.length; resultValue(await reception.startWorkflow(f.scope, f.turn(`task-${++task}`, operation), operation, now));
      const deadline = Date.now() + 5000; while (f.mail.length === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(f.mail.length, count + 1); await play();
      assert.equal((await owner.submitCode(f.mail.at(-1)!.code)).verified, true);
    };
    const perform = async (operation: CrossOperation): Promise<ActionState> => {
      const previous = new Set(Object.keys((await f.state()).actions));
      if (operation === "book") {
        resultValue(await reception.readBookingMenu(f.scope, turn("times"), "2026-10-08", "2026-10-08", now)); await play();
        resultValue(await reception.selectBookingMenu(f.scope, turn("select"), 1, now));
      } else if (operation === "cancel") {
        const proof = await owner.cancellationProof(); assert.ok(proof);
        resultValue(await reception.checkAppointments(f.scope, turn("appointments"), proof.verificationRef, now, "2026-10-09T06:00:00.000Z", now)); await play();
        resultValue(await reception.selectAppointment(f.scope, turn("choose"), proof.verificationRef, 1, now)); await play();
        resultValue(await reception.proposeAppointmentChange(f.scope, turn("cancel"), { kind: "cancel", verificationRef: proof.verificationRef, targetRef: "selected" }, now));
      } else {
        resultValue(await reception.readReschedulingMenu(f.scope, turn("targets"), "targets", now, "2026-10-09T06:00:00.000Z", now)); await play();
        resultValue(await reception.selectReschedulingMenu(f.scope, turn("choose-target"), "targets", 1, now)); await play();
        resultValue(await reception.readReschedulingMenu(f.scope, turn("offers"), "offers", "2026-10-08", "2026-10-08", now)); await play();
        resultValue(await reception.selectReschedulingMenu(f.scope, turn("choose-time"), "offers", 1, now));
      }
      const actions = Object.values((await f.state()).actions).filter(row => !previous.has(row.key)); assert.equal(actions.length, 1);
      const action = actions[0]!; assert.equal(action.status, "awaitingConfirmation");
      await play(); resultValue(await reception.affirm(f.scope, turn("yes", "Yes"), action.key, action.digest, now));
      resultValue(await reception.drain(f.scope, f.callId, now)); await play(); return (await f.state()).actions[action.key]!;
    };
    await play();
    return { ...f, flow: owner, flowConfig: sequence.config, reception, sequence, native, budget, start, perform, play,
      bindNativeCall: (read: typeof f.state) => { state = read; },
      close: async () => { owner.dispose(); await f.close(); } };
  } catch (error) { flow?.dispose(); await f.close(); throw error; }
}
