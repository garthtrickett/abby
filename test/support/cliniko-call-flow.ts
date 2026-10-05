import { join } from "node:path";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { err } from "../../src/core/model.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { bookingSessionFixture } from "./booking-session.ts";
import { cancellationSessionFixture } from "./cancellation-session.ts";
import { reschedulingSessionFixture } from "./rescheduling-session.ts";
import { intakeBookingSessionFixture } from "./intake-booking-session.ts";

function connect(config: ClinikoCallFlowConfig) {
  const flow = resultValue(ClinikoCallFlow.create(config));
  const reception = new TextReception(config.ledger as ConstructorParameters<typeof TextReception>[0], config.policies, flow, undefined, {
    list: (...args) => flow.appointments?.list(...args) ?? Promise.resolve(err({ kind: "unavailable" as const })),
    select: (...args) => flow.appointments?.select(...args) ?? Promise.resolve(err({ kind: "unavailable" as const })),
  });
  return { flow, reception, flowConfig: config };
}
function paths(caller: string, booking: string, cancellation = booking, rescheduling = booking) {
  return { bookCaller: caller, cancelCaller: caller, rescheduleCaller: caller, booking, cancellation, rescheduling };
}
export async function bookingCallFlowFixture(options: Parameters<typeof bookingSessionFixture>[0] = {}) {
  const f = await bookingSessionFixture(options); f.owner.dispose();
  try { return { ...f, ...connect({ ...f.config, approvals: paths(f.config.callerApprovalPath, f.config.bookingApprovalPath) }),
    get posts() { return f.posts; }, get claims() { return f.claims; } }; }
  catch (error) { await f.close(); throw error; }
}
export async function cancellationCallFlowFixture(options: Parameters<typeof cancellationSessionFixture>[0] = {}) {
  const f = await cancellationSessionFixture(options); f.owner.dispose();
  try { return { ...f, ...connect({ ...f.config, cliniko: { ...f.config.cliniko, practitionerId: "22", appointmentTypeId: "33" },
    approvals: paths(f.config.callerApprovalPath, f.config.cancellationApprovalPath, f.config.cancellationApprovalPath) }),
    get patches() { return f.patches; }, get claims() { return f.claims; } }; }
  catch (error) { await f.close(); throw error; }
}
export async function reschedulingCallFlowFixture(options: Parameters<typeof reschedulingSessionFixture>[0] = {}) {
  const f = await reschedulingSessionFixture(options); f.owner.dispose();
  try { return { ...f, ...connect({ ...f.config, approvals: paths(f.config.callerApprovalPath, f.config.bookingApprovalPath,
    f.config.reschedulingApprovalPath, f.config.reschedulingApprovalPath) }), get patches() { return f.patches; }, get claims() { return f.claims; } }; }
  catch (error) { await f.close(); throw error; }
}
export async function intakeCallFlowFixture(options: Parameters<typeof intakeBookingSessionFixture>[0] = {}) {
  const f = await intakeBookingSessionFixture(options); f.owner.dispose();
  try { return { ...f, ...connect({ ...f.config, permission: f.config.bookingPermission,
    lookup: { candidates: async () => { throw new Error("intake must not infer returning-patient identity"); } },
    approvals: paths(join(f.folder, "unused-caller-approval.json"), f.config.bookingApprovalPath),
    intake: { policy: f.config.policy, permission: f.config.permission, presentation: f.config.presentation } }) }; }
  catch (error) { await f.close(); throw error; }
}
