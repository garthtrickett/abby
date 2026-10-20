import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classGroup, classLink, classAttendee } from "./class-attendance.ts";
import { verificationCanaries } from "./caller-verification.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { err } from "../../src/core/model.ts";
import { classBookingFixture } from "./class-booking.ts";
import { classCancellationFixture } from "./class-cancellation.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import type { ClassPassCancellationEffect } from "../../src/standalone/cliniko-class-pass-cancellation.ts";

export async function classCallFlowFixture(operation: "book" | "cancel", multiple = false, passes = false, passCancellation?: ClassPassCancellationEffect) {
  const f = await (operation === "book" ? classBookingFixture({ passes }) : classCancellationFixture(passCancellation ? { passes: passCancellation } : {}));
  f.host.dispose(); f.session.dispose();
  const source = f.classSessionConfig;
  let flowConfig: ClinikoCallFlowConfig = { ...source,
    approvals: { bookCaller: source.callerApprovalPath, cancelCaller: source.callerApprovalPath, rescheduleCaller: source.callerApprovalPath,
      booking: f.path, cancellation: "cancellationApprovalPath" in source ? source.cancellationApprovalPath : f.path, rescheduling: f.path },
    classAttendance: { approvalPath: source.classApprovalPath, practitionerId: source.cliniko.practitionerId,
      appointmentTypeId: source.cliniko.appointmentTypeId, bookPermission: source.classPermission, cancelPermission: source.classPermission,
      ...("classPassAuthority" in source && source.classPassAuthority ? { passAuthority: source.classPassAuthority } : {}),
      ...("classPassCancellationAuthority" in source && source.classPassCancellationAuthority ? { passCancellationAuthority: source.classPassCancellationAuthority } : {}) } };
  let secondPath: string | undefined;
  if (multiple) {
    f.native.filterGroupServices();
    secondPath = join(f.folder, "reformer-class.json");
    await writeFile(secondPath, JSON.stringify({ ...f.approval, revision: "reformer-1", practitionerId: "23", appointmentTypeId: "34",
      serviceRef: "reformer-pilates", className: "Reformer Pilates", practitionerName: "Second Instructor", durationMinutes: 30 }), { mode: 0o600 });
    f.native.business.appointment_type_ids = ["33", "34"];
    f.native.groups.push({ ...classGroup("191"), practitioner: classLink("practitioners", "23"), appointment_type: classLink("appointment_types", "34"), ends_at: "2026-10-08T10:30:00.000Z" });
    if (operation === "cancel") f.native.attendees.push(classAttendee("201", "191", verificationCanaries[2]!));
    const fetchPort: typeof fetch = async (value, init) => {
      const url = new URL(String(value));
      if ((init?.method ?? "GET") === "GET") {
        if (url.pathname === "/v1/practitioners/23") return Response.json({ id: "23", active: true });
        if (url.pathname === "/v1/appointment_types/34") return Response.json({ id: "34", archived_at: null, max_attendees: 10 });
        if (url.pathname === "/v1/practitioners/23/businesses") return Response.json({ businesses: [{ id: "11", ...classLink("businesses", "11") }], total_entries: 1 });
        if (url.pathname === "/v1/practitioners/23/appointment_types") return Response.json({ appointment_types: [{ id: "34", ...classLink("appointment_types", "34") }], total_entries: 1 });
      }
      return source.fetchPort(value, init);
    };
    const { classAttendance, ...base } = flowConfig;
    flowConfig = { ...base, fetchPort, classServices: [classAttendance!, { ...classAttendance!, approvalPath: secondPath, practitionerId: "23", appointmentTypeId: "34" }] };
  }
  const flow = resultValue(ClinikoCallFlow.create(flowConfig));
  const reception = new TextReception(f.ledger, f.policies, flow, undefined, {
    list: (scope, ref, from, to, now) => flow.appointments?.list(scope, ref, from, to, now) ?? Promise.resolve(err({ kind: "unavailable" as const })),
    select: (scope, ref, choice, now) => flow.appointments?.select(scope, ref, choice, now) ?? Promise.resolve(err({ kind: "unavailable" as const })),
  }, undefined, undefined, source.clock);
  return { ...f, flow, reception, flowConfig, secondPath, get claims() { return f.claims; }, close: async () => { flow.dispose(); await f.close(); } };
}
