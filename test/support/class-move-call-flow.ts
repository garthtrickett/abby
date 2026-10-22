import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import { classMoveFixture } from "./class-move.ts";
import type { PassMoveOptions } from "./class-move.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export async function classMoveCallFlowFixture(different = false, multiple = false, passes?: PassMoveOptions, staging = false, activate = true,
  options: Pick<NonNullable<Parameters<typeof classMoveFixture>[5]>, "scope" | "budget" | "verificationBudget" | "memoFor"> = {}) {
  const f = await classMoveFixture(different, false, passes, staging, activate, options);
  f.host.dispose(); f.session.dispose();
  const c = f.classSessionConfig, forbidden = { allows: async () => false };
  const service = { approvalPath: c.classApprovalPath, practitionerId: c.cliniko.practitionerId, appointmentTypeId: c.cliniko.appointmentTypeId,
    bookPermission: forbidden, cancelPermission: forbidden, move: { approvalPath: c.moveApprovalPath, permission: c.classPermission,
      ...(c.classPassMoveAuthority ? { passAuthority: c.classPassMoveAuthority } : {}),
      destination: { approvalPath: c.destination.classApprovalPath, practitionerId: c.destination.practitionerId, appointmentTypeId: c.destination.appointmentTypeId } } };
  const flowConfig: ClinikoCallFlowConfig = { ...c,
    approvals: { bookCaller: f.path, cancelCaller: f.path, rescheduleCaller: f.path, booking: f.sourcePath, cancellation: f.sourcePath, rescheduling: f.movePath },
    ...(multiple ? { classServices: [service] } : { classAttendance: service }) };
  const flow = resultValue(ClinikoCallFlow.create(flowConfig));
  return { ...f, flow, flowConfig, close: async () => { flow.dispose(); await f.close(); } };
}
