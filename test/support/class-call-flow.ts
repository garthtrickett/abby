import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { err } from "../../src/core/model.ts";
import { classBookingFixture } from "./class-booking.ts";
import { classCancellationFixture } from "./class-cancellation.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export async function classCallFlowFixture(operation: "book" | "cancel") {
  const f = await (operation === "book" ? classBookingFixture() : classCancellationFixture());
  f.host.dispose(); f.session.dispose();
  const source = f.classSessionConfig;
  const flowConfig: ClinikoCallFlowConfig = { ...source,
    approvals: { bookCaller: source.callerApprovalPath, cancelCaller: source.callerApprovalPath, rescheduleCaller: source.callerApprovalPath,
      booking: f.path, cancellation: "cancellationApprovalPath" in source ? source.cancellationApprovalPath : f.path, rescheduling: f.path },
    classAttendance: { approvalPath: source.classApprovalPath, practitionerId: source.cliniko.practitionerId,
      appointmentTypeId: source.cliniko.appointmentTypeId, bookPermission: source.classPermission, cancelPermission: source.classPermission } };
  const flow = resultValue(ClinikoCallFlow.create(flowConfig));
  const reception = new TextReception(f.ledger, f.policies, flow, undefined, {
    list: (scope, ref, from, to, now) => flow.appointments?.list(scope, ref, from, to, now) ?? Promise.resolve(err({ kind: "unavailable" as const })),
    select: (scope, ref, choice, now) => flow.appointments?.select(scope, ref, choice, now) ?? Promise.resolve(err({ kind: "unavailable" as const })),
  }, undefined, undefined, source.clock);
  return { ...f, flow, reception, flowConfig, get claims() { return f.claims; }, close: async () => { flow.dispose(); await f.close(); } };
}
