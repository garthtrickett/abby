import assert from "node:assert/strict";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { representativeCallOwnerFixture, representativeInputOptions } from "./representative-call-owner.ts";
import { guardianCallOwnerFixture } from "./guardian-call-owner.ts";
import { syntheticMultiTaskBookingProvider, syntheticTaskSequence } from "./call-task-sequence.ts";
import { verificationCanaries, verificationNow } from "./caller-verification.ts";

export async function relatedSelfTaskSequenceFixture(options: Readonly<{ guardian?: true; enquiry?: true; budget?: ClinikoRequestBudget; subjectIds?: readonly [string, string] }> = {}) {
  assert.ok(!options.enquiry || !options.guardian, "mixed enquiry controls use the native-patient related-caller process");
  let current = verificationNow, sequence = 0, selfAllowed = true;
  const sourceBudget = new ClinikoReadBudget(180, () => Date.parse(current)), budget = options.budget ?? sourceBudget;
  const selected = { budget, ...(options.subjectIds ? { subjectIds: options.subjectIds } : {}) };
  const guardian = options.guardian ? await guardianCallOwnerFixture(selected) : undefined;
  const base = guardian?.base ?? await representativeCallOwnerFixture({ multiplePatients: true, ...selected,
    ...(options.enquiry ? { operation: "appointments.read" as const, allowedOperations: ["book", "appointments.read"] as const } : {}) });
  base.flow.dispose(); guardian?.flow.dispose();
  const original = guardian?.flowConfig ?? base.flowConfig, native = syntheticMultiTaskBookingProvider();
  const permission = { allows: async (scope: Parameters<typeof original.permission.allows>[0], id: string, operation: string) =>
    id === verificationCanaries[2] ? selfAllowed && (operation === "appointments.book" || options.enquiry === true && operation === "appointments.read")
      : original.permission.allows(scope, id) };
  const enquiry = options.enquiry ? original.enquiry : undefined;
  if (options.enquiry) assert.ok(enquiry);
  const source = await syntheticTaskSequence({ ...original, clock: () => current, permission,
    ...(enquiry ? { enquiry: { ...enquiry, permission } } : {}),
    representativeInput: guardian?.input ?? representativeInputOptions(base),
    fetchPort: native.wrap(async (value, init) => {
      // The original representative fixture permits only related subjects on
      // recall writes. Its original native-self transport supplies self recalls.
      const url = new URL(String(value));
      if (url.pathname === "/v1/recalls" && init?.method === "POST" && JSON.parse(String(init.body)).patient_id === verificationCanaries[2])
        return base.f.ownerPorts.fetchPort(value, init);
      if (options.enquiry && url.pathname === "/v1/individual_appointments" && (init?.method ?? "GET") === "GET" &&
          url.searchParams.getAll("q[]").includes(`patient_id:=${verificationCanaries[2]}`)) {
        const row = { id: "83", starts_at: "2026-10-08T06:00:00.000Z", ends_at: "2026-10-08T06:30:00.000Z",
          cancelled_at: null, archived_at: null, deleted_at: null,
          patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${verificationCanaries[2]}` } },
          business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } } };
        return Response.json({ total_entries: 1, individual_appointments: [row] });
      }
      return original.fetchPort(value, init);
    }),
  }, base.f.folder);
  await source.replace({ patientSelection: "independentlyVerifiedPatients" });
  const flow = resultValue(ClinikoCallFlow.create(source.config));
  const reception = new TextReception(base.f.ledger, base.f.policies, flow, undefined, undefined, undefined, undefined, () => current);
  const turn = (text: string) => ({ ...base.f.turn(`related-self-${++sequence}`, text), at: current });
  const play = async () => {
    const id = (await base.f.state()).pendingPresentationId; assert.ok(id);
    resultValue(await base.f.runtime.startPresentation(base.f.callId, id, base.f.sessionId, current));
    resultValue(await base.f.runtime.resolvePresentation(base.f.callId, id, "played", base.f.sessionId, current));
  };
  const query = () => ({ scope: base.f.scope, callId: base.f.callId, sessionId: base.f.sessionId,
    policyVersion: source.config.policyVersion, operation: "book" as const, signal: new AbortController().signal });
  const prepareRelated = async (operation: "book" | "appointments.read" = "book") => {
    resultValue(await reception.startWorkflow(base.f.scope, turn(operation === "book" ? "Book an appointment for another person" : "Check an appointment for another person"), operation, current,
      (await base.f.state()).conversationRevision, undefined, false, undefined, true)); await play();
    const owner = flow.representativeInputOwner; assert.ok(owner);
    return owner;
  };
  const startRelated = async (operation: "book" | "appointments.read" = "book") => {
    const owner = await prepareRelated(operation);
    const count = base.mail.length;
    assert.equal(owner.beginCallerVerification(), true); await base.waitForMail(count + 1);
    assert.equal((await owner.submitCallerCode(base.mail.at(-1)!.code)).verified, true);
    resultValue(await owner.selectPatient(base.r.identity));
    assert.equal(owner.beginPatientVerification(), true); await base.waitForMail(count + 2);
    assert.equal((await flow.submitCode(base.mail.at(-1)!.code)).verified, true);
    return owner;
  };
  const startCaller = async (request: Readonly<{ operation: "book" | "appointments.read"; returning?: true; signal?: AbortSignal }>) => reception.startWorkflow(base.f.scope,
    turn(request.operation === "book" ? "Book an appointment for myself" : "Check my appointments for myself"), request.operation, current,
    (await base.f.state()).conversationRevision, request.signal, false, undefined, undefined, undefined, undefined, request.returning);
  const startSelf = async (returning = true, external?: AbortSignal) => startCaller({ operation: "book",
    ...(returning ? { returning: true as const } : {}), ...(external ? { signal: external } : {}) });
  const verifyCaller = async (start: () => ReturnType<typeof startSelf>) => {
    const count = base.mail.length;
    resultValue(await start()); await play(); await base.waitForMail(count + 1);
    assert.equal((await flow.submitCode(base.mail.at(-1)!.code)).verified, true);
  };
  const verifySelf = (returning = true) => verifyCaller(() => startSelf(returning));
  const verifyCallerEnquiry = () => verifyCaller(() => startCaller({ operation: "appointments.read" }));
  const startRelatedEnquiry = () => startRelated("appointments.read");
  const readEnquiry = async () => {
    resultValue(await reception.enquireAppointments(base.f.scope, turn("Check the appointment"),
      { from: current, to: "2026-10-09T06:00:00.000Z" }, current));
    const read = (await base.f.state()).appointmentReads.at(-1); assert.ok(read); return structuredClone(read);
  };
  const book = async () => {
    resultValue(await reception.readBookingMenu(base.f.scope, turn("Times"), "2026-10-08", "2026-10-08", current)); await play();
    resultValue(await reception.selectBookingMenu(base.f.scope, turn("First option"), 1, current)); await play();
    const action = Object.values((await base.f.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation");
    resultValue(await reception.affirm(base.f.scope, turn("Yes"), action.key, action.digest, current));
    resultValue(await reception.drain(base.f.scope, base.f.callId, current)); await play();
    return (await base.f.state()).actions[action.key]!;
  };
  const nextWindow = async () => {
    assert.equal(options.budget, undefined, "external native budgets cannot use the controlled source clock");
    const began = Date.parse(current);
    for (const seconds of [20, 40, 61]) {
      current = new Date(began + seconds * 1000).toISOString(); base.f.setTime(current);
      const lease = (await base.f.state()).sessionLease!;
      resultValue(await base.f.runtime.renewSession(base.f.callId, base.f.sessionId, lease.version, current));
    }
    assert.equal(sourceBudget.checkHeadroom(180), null);
  };
  return { base, guardian, source, native, flow, reception, turn, play, query, prepareRelated, startRelated, startSelf, verifySelf,
    verifyCallerEnquiry, startRelatedEnquiry, readEnquiry, book, nextWindow,
    now: () => current, denySelf: () => { selfAllowed = false; }, close: async () => { flow.dispose(); await (guardian ? guardian.close() : base.close()); } };
}
