import { isDeepStrictEqual } from "node:util";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { validGreetingAt } from "../core/greeting.ts";
import type { ApprovedGreeting } from "../core/model.ts";
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
  clinical: Omit<ClinikoOutboundCallFlowConfig, CallOwned>;
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
  const clinical = Object.freeze({ ...config.clinical, cliniko: Object.freeze({ ...config.clinical.cliniko }),
    approvals: Object.freeze({ ...config.clinical.approvals }),
    ...(config.clinical.reschedulingDestination ? { reschedulingDestination: Object.freeze({ ...config.clinical.reschedulingDestination }) } : {}),
    ...(config.clinical.reschedulingPractitioners ? { reschedulingPractitioners: Object.freeze(config.clinical.reschedulingPractitioners.map(member => Object.freeze({ ...member }))) } : {}) });
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
    let context: ClinikoOutboundClinicalContext | undefined, flow: ClinikoCallFlow | undefined, created = false;
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
      if (signal.aborted || !context.current("appointments.reschedule")) throw Error("Clinical conversation unavailable");
      const keypad = new PrivateWorkflowKeypad({ callId, sessionId, owner: () => flow });
      const privateKeypadInput = { claim: keypad.claim.bind(keypad), start: keypad.start.bind(keypad), blocked: keypad.blocked.bind(keypad),
        accept: keypad.accept.bind(keypad), stop: () => { keypad.stop(); stop(); } };
      return { privateKeypadInput, create(receipt, selectedSessionId, playback) {
        if (created || signal.aborted || selectedSessionId !== sessionId || receipt.callId !== callId ||
            !context!.matchesAdmission(receipt) || !context!.current("appointments.reschedule") ||
            !validGreetingAt(greeting, call.scope, clock())) { stop(); throw Error("Clinical conversation unavailable"); }
        created = true;
        const made = ClinikoCallFlow.createOutbound({ ...clinical, receipt, sessionId, ledger,
          outbound: context!, signal, clock });
        if (!made.ok) { stop(); throw Error("Clinical conversation unavailable"); }
        flow = made.value;
        try {
          const reception = new TextReception(ledger, clinical.policies, flow, undefined, undefined, undefined,
            clinical.publicKnowledge, clock);
          return new VoiceSession(callId, sessionId, receipt.scope, ledger, reception, playback, intent(flow), undefined,
            monotonicNow, { greeting, staffWorkUnavailable: true });
        } catch { stop(); throw Error("Clinical conversation unavailable"); }
      } };
    } catch { stop(); throw Error("Clinical conversation unavailable"); }
  };
}
