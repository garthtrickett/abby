import { randomUUID } from "node:crypto";
import { ClinikoOutboundClinicalContext } from "../../src/standalone/cliniko-outbound-clinical-context.ts";
import type { OutboundClinicalContextQuery } from "../../src/standalone/cliniko-outbound-clinical-context.ts";
import { CallerVerificationSession } from "../../src/standalone/caller-verification-session.ts";
import { ClinikoVerificationContactReader } from "../../src/cliniko/verification-contact.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { callerVerificationFixture } from "./caller-verification.ts";
import { outboundRequestValue } from "./outbound-recipient-request.ts";
import { outboundRecordsFixture, value, outboundNow } from "./outbound-records.ts";
import { outboundLaunchValue } from "./outbound-launch.ts";

export async function outboundClinicalVerificationFixture() {
  const f = await callerVerificationFixture({ now: outboundNow, operation: "appointments.book", bookingExecute: true });
  f.session.dispose();
  const lifetime = new AbortController();
  try {
    const request = { ...outboundRequestValue(), scope: f.scope, patientId: "482746192837465", recipient: { kind: "voice" as const, number: "+61400111222" } };
    const native = await outboundRecordsFixture({ request });
    value(await native.retain());
    const original = { recallRef: "cliniko:recall:40", attempt: outboundLaunchValue(native.request).attempt };
    const key = { accountRef: "synthetic-outbound-account", providerCallRef: "outgoing-" + randomUUID() }, callId = callIdFor(key), sessionId = randomUUID();
    const runtime = new CallRuntime(f.ledger, f.scope), clinicNumber = "+6125550199";
    const policy = (await f.state()).policy;
    value(await runtime.admit(callId, policy, { direction: "outbound", key, clinicNumber, acceptedAt: outboundNow, deadline: "2026-11-01T10:00:30.000Z" }));
    value(await runtime.activate(callId, sessionId, outboundNow));
    const receipt = value(await f.ledger.findAdmission(callId))!;
    const queries: OutboundClinicalContextQuery[] = [];
    const state = { current: true, allowed: true, decodedCurrent: true, beforeApproval: undefined as undefined | ((query: OutboundClinicalContextQuery) => void | Promise<void>) };
    const contextConfig = { original, key, clinicNumber, requests: native.config, records: native.authority, signal: lifetime.signal, fetchPort: native.port,
      authority: { allows: async (query: OutboundClinicalContextQuery) => { queries.push(query); await state.beforeApproval?.(query); return state.allowed; },
        current: (query: OutboundClinicalContextQuery) => state.current && (!query.record || state.decodedCurrent) } };
    const capture = () => ClinikoOutboundClinicalContext.capture(contextConfig);
    const contact = new ClinikoVerificationContactReader({ scope: f.scope, apiKey: native.config.apiKey, contactEmail: native.config.contactEmail,
      countryCallingCode: "61", rateBudget: native.config.rateBudget }, f.fetchPort);
    let onDelivery: (() => void) | undefined;
    const send = f.sessionConfig.delivery.send.bind(f.sessionConfig.delivery);
    const delivery = { send: async (...args: Parameters<typeof send>) => { const result = await send(...args); onDelivery?.(); return result; } };
    const makeConfig = (outbound: ClinikoOutboundClinicalContext) => {
      const { inbound: _, ...base } = f.sessionConfig;
      return { ...base, receipt, sessionId, contact, outbound, delivery };
    };
    const make = (outbound: ClinikoOutboundClinicalContext) => CallerVerificationSession.createOutbound(makeConfig(outbound));
    return { ...f, native, original, key, callId, sessionId, receipt, runtime, lifetime, contextConfig, queries, state, capture, make, makeConfig,
      onDelivery: (next: () => void) => { onDelivery = next; },
      close: async () => { lifetime.abort(); await f.close(); } };
  } catch (error) { lifetime.abort(); await f.close(); throw error; }
}
