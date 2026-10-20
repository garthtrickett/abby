import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { outboundLaunchRecordSelection } from "../cliniko/outbound-launch-records.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { ClinikoOutboundContactSettlement } from "./cliniko-outbound-contact-settlement.ts";
import { ClinikoOutboundTerminalOwner } from "./cliniko-outbound-terminal-owner.ts";
import { TwilioAbbyOutboundFinality } from "./twilio-outbound-finality.ts";

type ContactConfig = Parameters<typeof ClinikoOutboundContactSettlement.create>[0];
type CallConfig = Parameters<typeof ClinikoOutboundTerminalOwner.create>[0];
type AdapterConfig = Parameters<typeof TwilioAbbyOutboundFinality.create>[0];
type ContactPorts = Parameters<typeof ClinikoOutboundContactSettlement.create>[1];
type CallPorts = Parameters<typeof ClinikoOutboundTerminalOwner.create>[1];
type AdapterPorts = Parameters<typeof TwilioAbbyOutboundFinality.create>[1];
export type TwilioFinalityRecoveryConfig = Readonly<{ contact: ContactConfig; call: CallConfig; reports: AdapterConfig["reports"] }>;
export type TwilioFinalityRecoveryPorts = Readonly<{ adapter: Omit<AdapterPorts, "native">; native: typeof fetch;
  contact: Omit<ContactPorts, "provider" | "native">; call: Omit<CallPorts, "provider" | "native"> }>;
type Outcome = Readonly<{ contact: Awaited<ReturnType<ClinikoOutboundContactSettlement["settleOnce"]>>;
  call: Awaited<ReturnType<ClinikoOutboundTerminalOwner["inspectAndRelease"]>> }>;

/** One bounded recovery purpose across the concrete native/provider adapter and
 * BOTH existing independent owners. Every native scan/reread/mutation uses the
 * same captured physical API-user budget and a shared180-claim operation bound,
 * including after a real minute rolls over. No native report/outcome IDs are
 * invented, no write is replayed, and one hold's result cannot clear the other. */
export async function recoverTwilioOutboundFinality(c: TwilioFinalityRecoveryConfig, p: TwilioFinalityRecoveryPorts,
  input: Parameters<ClinikoOutboundContactSettlement["settleOnce"]>[0], external: AbortSignal): Promise<Result<Outcome, Readonly<{ kind: "invalidConfig" | "unavailable" }>>> {
  if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000), signal = AbortSignal.any([external, controller.signal]);
  try {
    const contact = c.contact, physical = contact.stop.requests.rateBudget;
    const sources = [contact.stop.attempts, contact.stop.dnc.source, contact.outcomes, c.call.attempts, c.reports];
    if (!sources.every(s => s.rateBudget === physical && s.apiKey === contact.stop.requests.apiKey && s.businessId === contact.stop.requests.businessId && isDeepStrictEqual(s.scope, contact.stop.requests.scope)) ||
        !isDeepStrictEqual(outboundLaunchRecordSelection(c.call.attempts), outboundLaunchRecordSelection(contact.stop.attempts)) ||
        new Set([contact.stop.requests.outboundRecallTypeId, contact.stop.attempts.outboundAttemptRecallTypeId, contact.stop.dnc.source.contactReviewRecallTypeId,
          contact.outcomes.outboundContactOutcomeRecallTypeId, c.reports.outboundProviderReportRecallTypeId]).size !== 5) return err({ kind: "invalidConfig" });
    const claim = physical.claim.bind(physical), observe429 = physical.observe429.bind(physical), headroom = physical.checkHeadroom?.bind(physical); let claims = 0;
    const budget: ClinikoRequestBudget = Object.freeze({ claim: () => signal.aborted || ++claims > 180 ? { kind: "unavailable" as const } : claim(), observe429,
      ...(headroom ? { checkHeadroom: (requests: number) => signal.aborted || claims + requests > 180 ? { kind: "unavailable" as const } : headroom(requests) } : {}) });
    const stop = { ...contact.stop, requests: { ...contact.stop.requests, rateBudget: budget }, attempts: { ...contact.stop.attempts, rateBudget: budget },
      dnc: { ...contact.stop.dnc, source: { ...contact.stop.dnc.source, rateBudget: budget } } };
    const adapter = TwilioAbbyOutboundFinality.create({ reports: { ...c.reports, rateBudget: budget }, attempts: stop.attempts }, { ...p.adapter, native: p.native });
    if (!adapter.ok) return err({ kind: "invalidConfig" }); const provider = adapter.value.contactProvider();
    const settlement = ClinikoOutboundContactSettlement.create({ ...contact, stop, outcomes: { ...contact.outcomes, rateBudget: budget } }, { ...p.contact, provider, native: p.native });
    const terminal = ClinikoOutboundTerminalOwner.create({ ...c.call, attempts: { ...c.call.attempts, rateBudget: budget } }, { ...p.call, provider, native: p.native });
    if (!settlement.ok || !terminal.ok) return err({ kind: "invalidConfig" });
    const binding = Object.freeze(structuredClone(input));
    const contactResult = await settlement.value.settleOnce(binding, signal);
    const callResult = await terminal.value.inspectAndRelease(binding, signal);
    return ok(Object.freeze({ contact: contactResult, call: callResult }));
  } catch { return err({ kind: "unavailable" }); } finally { clearTimeout(timer); controller.abort(); }
}
