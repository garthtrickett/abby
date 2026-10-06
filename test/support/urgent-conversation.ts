import { ok } from "../../src/core/model.ts";
import type { ApprovedUrgentResponse } from "../../src/core/model.ts";
import { bookingCallFlowFixture } from "./cliniko-call-flow.ts";
import { clinikoStaffCallFlowFixture } from "./cliniko-staff-call-flow.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export const urgentScript = "If you need immediate help, contact your local emergency service now.";
export const urgentQuestion = "I think this needs urgent medical attention.";
export const urgentFallback = "I can't give advice on that request. Please contact the clinic directly.";
export const urgentReply = `${urgentScript} I can't send a staff request from this call. Please contact the clinic directly.`;

/** Actual clinic-admin urgent setting; only its public script/permission, mail,
 * speech and Cliniko responses are synthetic. An ordinary recall process grants
 * no urgent destination or authority to diagnose, transfer or send a recall. */
export async function urgentConversationFixture(options: { staff?: boolean; shortExpiry?: boolean; missing?: boolean } = {}) {
  const staff = options.staff ? await clinikoStaffCallFlowFixture() : undefined;
  const f = staff ?? await bookingCallFlowFixture(); f.flow.dispose();
  try {
    const response: ApprovedUrgentResponse = { scope: f.scope, version: "synthetic-urgent-1", ownerRef: "synthetic-admin", approvedText: urgentScript,
      approved: true, effectiveFrom: "2026-10-04T06:00:00.000Z", effectiveUntil: options.shortExpiry ? "2026-10-04T06:00:01.000Z" : "2026-10-05T06:00:00.000Z" };
    const before = resultValue(await f.policies.read(f.scope));
    if (!options.missing) resultValue(await f.policies.changeUrgentResponse(f.scope, before.policyVersion, response, "synthetic-admin"));
    const current = resultValue(await f.policies.read(f.scope));
    await f.replacePolicy({ policyVersion: current.policyVersion });
    if (staff) await staff.replaceStaffApproval({ policyVersion: current.policyVersion });
    let override: unknown, overrideSet = false;
    const policies = new Proxy(f.policies, { get(target, key) {
      if (key === "read") return async (...args: Parameters<typeof target.read>) => {
        const found = await target.read(...args);
        return found.ok && overrideSet ? ok({ ...found.value, urgentResponse: override as ApprovedUrgentResponse }) : found;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    return { ...f, response, policies, get staffPosts() { return staff?.staffPosts ?? 0; }, flowConfig: { ...f.flowConfig, policies, policyVersion: current.policyVersion },
      setUrgentOverride: (value: unknown) => { override = value; overrideSet = true; },
      disableUrgent: async () => { const policy = resultValue(await f.policies.read(f.scope)); return f.policies.changeUrgentResponse(f.scope, policy.policyVersion, undefined, "synthetic-admin"); } };
  } catch (error) { await f.close(); throw error; }
}
