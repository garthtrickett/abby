import { captureFinancialVoiceProvision, financialVoiceForCall } from "./financial-voice-provision.ts";
import { captureBookingMemoConfig } from "./cliniko-booking-memo.ts";
import type { FinancialVoiceProvision } from "./financial-voice-provision.ts";
import { PrivateFinancialBookingInput } from "./private-financial-booking-input.ts";
import { isDeepStrictEqual } from "node:util";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { validGreetingAt } from "../core/greeting.ts";
import type { ApprovedGreeting } from "../core/model.ts";
import { err } from "../core/model.ts";
import { TextReception } from "../reference/text-reception.ts";
import { callIdFor } from "../voice/admission.ts";
import type { PreparedVoiceSession } from "../voice/reception-voice-call.ts";
import { VoiceSession } from "../voice/voice-session.ts";
import type { IntentResolver } from "../voice/voice-session.ts";
import { ClinikoCallFlow } from "./cliniko-call-flow.ts";
import type { ClinikoOutboundCallFlowConfig } from "./cliniko-call-flow.ts";
import { ClinikoOutboundClinicalContext } from "./cliniko-outbound-clinical-context.ts";
import { PrivateWorkflowKeypad } from "./private-workflow-keypad.ts";
import type { OutboundVoicePreparation } from "./twilio-outbound-conversation.ts";

type CallOwned = "receipt" | "sessionId" | "ledger" | "signal" | "clock" | "outbound";
export type ClinikoOutboundVoiceConfig = Readonly<{
  clinical: Omit<ClinikoOutboundCallFlowConfig, CallOwned | "financial">;
  financial?: FinancialVoiceProvision;
  context: Omit<Parameters<typeof ClinikoOutboundClinicalContext.capture>[0], "original" | "key" | "clinicNumber" | "signal" | "fetchPort">;
  greeting: ApprovedGreeting;
  intent: (flow: ClinikoCallFlow) => IntentResolver;
  clock: () => string;
  monotonicNow?: () => number;
}>;

/** Optional clinical implementation of the prepared-session port. Native routing,
 * verification and the real private keypad stay together in one call-owned
 * closure. A carrier/runtime adapter receives only the generic prepared bundle. */
export function clinikoOutboundVoice(config: ClinikoOutboundVoiceConfig):
  (preparation: OutboundVoicePreparation) => Promise<PreparedVoiceSession> {
  if (Object.hasOwn(config.clinical, "financial")) throw Error("Clinical conversation unavailable");
  const clinical = Object.freeze({ ...config.clinical, cliniko: Object.freeze({ ...config.clinical.cliniko }),
    ...(config.clinical.memo ? { memo: captureBookingMemoConfig(config.clinical.memo, { scope: config.context.requests.scope,
      ...config.clinical.cliniko, credentialFingerprint: clinikoCredentialFingerprint(config.clinical.cliniko.apiKey), clock: config.clock }) } : {}),
    approvals: Object.freeze({ ...config.clinical.approvals }),
    ...(config.clinical.reschedulingDestination ? { reschedulingDestination: Object.freeze({ ...config.clinical.reschedulingDestination }) } : {}),
    ...(config.clinical.reschedulingPractitioners ? { reschedulingPractitioners: Object.freeze(config.clinical.reschedulingPractitioners.map(member => Object.freeze({ ...member }))) } : {}) });
  const financial = config.financial ? captureFinancialVoiceProvision(config.financial,
    { scope: config.context.requests.scope, ...clinical.cliniko }) : undefined;
  const usedPolicies = new WeakSet<object>();
  const contextConfig = Object.freeze({ ...config.context, requests: Object.freeze({ ...config.context.requests,
    scope: Object.freeze({ ...config.context.requests.scope }) }),
    records: Object.freeze({ allows: config.context.records.allows.bind(config.context.records), current: config.context.records.current.bind(config.context.records) }),
    authority: Object.freeze({ allows: config.context.authority.allows.bind(config.context.authority), current: config.context.authority.current.bind(config.context.authority) }),
    ...(config.context.target ? { target: Object.freeze({ appointmentPolicyDigest: config.context.target.appointmentPolicyDigest,
      authority: Object.freeze({ allows: config.context.target.authority.allows.bind(config.context.target.authority), current: config.context.target.authority.current.bind(config.context.target.authority) }) }) } : {}) });
  const greeting = Object.freeze(structuredClone(config.greeting)), intent = config.intent.bind(config), clock = config.clock.bind(config);
  const monotonicNow = config.monotonicNow?.bind(config);
  return async preparation => {
    const lifetime = new AbortController(), signal = AbortSignal.any([preparation.signal, lifetime.signal]);
    const ledger = preparation.ledger, sessionId = preparation.sessionId, call = structuredClone(preparation.call);
    let context: ClinikoOutboundClinicalContext | undefined, flow: ClinikoCallFlow | undefined, voice: VoiceSession | undefined, created = false;
    const stop = () => { lifetime.abort(); flow?.dispose(); context?.dispose(); };
    try {
      const callId = callIdFor(call.key);
      if (signal.aborted || !validGreetingAt(greeting, call.scope, clock()) ||
          !isDeepStrictEqual(call.scope, contextConfig.requests.scope) ||
          contextConfig.requests.businessId !== clinical.cliniko.businessId ||
          clinikoCredentialFingerprint(contextConfig.requests.apiKey) !== clinikoCredentialFingerprint(clinical.cliniko.apiKey) ||
          contextConfig.requests.rateBudget !== clinical.cliniko.rateBudget) throw Error("Clinical conversation unavailable");
      const captured = await ClinikoOutboundClinicalContext.capture({ ...contextConfig, requests: { ...contextConfig.requests, clock }, original: preparation.original, key: call.key,
        clinicNumber: call.clinicNumber, signal, ...(clinical.fetchPort ? { fetchPort: clinical.fetchPort } : {}) });
      if (!captured.ok) throw Error("Clinical conversation unavailable");
      context = captured.value;
      const operation = context.current("appointments.book") ? "appointments.book" : "appointments.reschedule";
      if (signal.aborted || !context.current(operation)) throw Error("Clinical conversation unavailable");
      const keypad = new PrivateWorkflowKeypad({ callId, sessionId, owner: () => flow });
      const input = new PrivateFinancialBookingInput(keypad, () => flow);
      const privateKeypadInput = { claim: input.claim.bind(input), start: input.start.bind(input), blocked: input.blocked.bind(input),
        handlesDigit: input.handlesDigit.bind(input), captureDigit: input.captureDigit.bind(input), acceptMedia: input.acceptMedia.bind(input),
        accept: input.accept.bind(input), stop: () => { input.stop(); stop(); } };
      return { privateKeypadInput, create(receipt, selectedSessionId, playback) {
        if (created || signal.aborted || selectedSessionId !== sessionId || receipt.callId !== callId ||
            !context!.matchesAdmission(receipt) || !context!.current(operation) ||
            !validGreetingAt(greeting, call.scope, clock())) { stop(); throw Error("Clinical conversation unavailable"); }
        created = true;
        try {
          const provision = financial && operation === "appointments.book" ? financialVoiceForCall(financial,
            { scope: receipt.scope, callId, sessionId, signal, clock }, { async play(text, abort, canPresent) {
              const played = await voice?.presentPrivateFinancialBooking(text, abort, clock(), canPresent);
              return played ? { ...played, playedAt: clock() } : undefined;
            } }, usedPolicies) : undefined;
          const made = ClinikoCallFlow.createOutbound({ ...clinical, receipt, sessionId, ledger,
            outbound: context!, signal, clock, ...(provision ? { financial: provision } : {}) });
          if (!made.ok) throw Error("Clinical conversation unavailable");
          const owner = made.value; flow = owner;
          const reception = new TextReception(ledger, clinical.policies, owner, undefined, {
            list: (...args) => owner.appointments?.list(...args) ?? Promise.resolve(err({ kind: "unavailable" as const })),
            select: (...args) => owner.appointments?.select(...args) ?? Promise.resolve(err({ kind: "unavailable" as const })),
          }, undefined,
            clinical.publicKnowledge, clock);
          voice = new VoiceSession(callId, sessionId, receipt.scope, ledger, reception, playback, intent(flow), undefined,
            monotonicNow, { greeting, staffWorkUnavailable: true });
          return voice;
        } catch { stop(); throw Error("Clinical conversation unavailable"); }
      } };
    } catch { stop(); throw Error("Clinical conversation unavailable"); }
  };
}
