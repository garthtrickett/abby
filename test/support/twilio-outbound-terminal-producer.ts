import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { approvedSyntheticPolicy } from "./approved-voice.ts";
import { outboundConversationProfileRef } from "../../src/voice/outbound-voice-entry.ts";
import { TwilioAbbyOutboundRuntime } from "../../src/voice/twilio-outbound-runtime.ts";
import { TwilioOutboundTerminalObservationProducer, twilioTerminalObservationProfileBinding } from "../../src/standalone/twilio-outbound-terminal-observation.ts";
import type { TwilioOutboundTerminalObservationConfig, TwilioOutboundTerminalObservationQuery } from "../../src/cliniko/twilio-outbound-terminal-observation-records.ts";
import { TwilioOutboundTerminalObservationAuthentication } from "../../src/cliniko/twilio-outbound-terminal-observation.ts";
import { outboundRecordsFixture, value } from "./outbound-records.ts";
import { outboundLaunchValue } from "./outbound-launch.ts";
import type { OutboundConversationApproval } from "../../src/voice/outbound-voice-entry.ts";
import type { OutboundEffectBarrier } from "../../src/core/outbound-effect-barrier.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { SignedTwilioWebhook } from "../../src/voice/twilio-signed-ingress.ts";

type Options = Pick<NonNullable<Parameters<typeof outboundRecordsFixture>[0]>, "response" | "deadlineMs" | "request"> & { legacy?: boolean; carrierRead?: typeof fetch; budget?: ClinikoRequestBudget; effectsFactory?: (scope: import("../../src/core/model.ts").LocationScope, owner: string) => OutboundEffectBarrier };
/** Real runtime POST/sealed original and signed status authentication; remote
 * carrier/native transports and clinic/profile grants remain synthetic. */
export async function twilioOutboundTerminalProducerFixture(options: Options = {}) {
  const { legacy, carrierRead, budget, effectsFactory, ...nativeOptions } = options;
  const native = await outboundRecordsFixture({ typeId: "66", ...nativeOptions }), seed = outboundLaunchValue(native.request), key = Buffer.alloc(32, 41);
  const state = { source: true, record: true, producer: true, current: true,
    beforeSource: undefined as (() => void | Promise<void>) | undefined, beforeBudget: undefined as (() => void | Promise<void>) | undefined };
  const observations: TwilioOutboundTerminalObservationConfig = { ...native.config, outboundTerminalObservationRecallTypeId: "66", terminalObservationPolicyDigest: "a".repeat(64),
    rateBudget: { claim: async () => { await state.beforeBudget?.(); const limited = budget ? await budget.claim() : null; return limited ?? native.config.rateBudget.claim(); },
      observe429: budget ? budget.observe429.bind(budget) : native.config.rateBudget.observe429,
      ...(budget?.checkHeadroom ? { checkHeadroom: budget.checkHeadroom.bind(budget) } : {}) } };
  const scope = observations.scope, approval: OutboundConversationApproval = { purpose: "outboundContact", runtimeConfigurationHash: "a".repeat(64),
    ...(!legacy ? { terminalObservationBinding: twilioTerminalObservationProfileBinding(observations, key)! } : {}),
    policy: approvedSyntheticPolicy({ ...referenceDefaultPolicy(scope), automationEnabled: true,
      greeting: { scope, version: "outbound-v1", ownerRef: "clinic-owner", approved: true, approvedText: "Hello, this is Abby calling on behalf of the clinic.",
        effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z" } }) };
  const config = { ref: "twilio-abby", profileRef: outboundConversationProfileRef(approval)!, accountSid: "AC" + "1".repeat(32),
    authToken: "synthetic-terminal-provider-token", from: "+61255550100", publicAnswerUrl: "https://clinic.example.invalid/outbound/answer",
    publicStatusUrl: "https://clinic.example.invalid/outbound/status", publicStreamUrl: "wss://clinic.example.invalid/outbound/stream", contextKey: Buffer.alloc(32, 42),
    now: native.config.clock! };
  const callSid = "CA" + "2".repeat(32); let form!: URLSearchParams, carrierRequests = 0;
  const runtime = new TwilioAbbyOutboundRuntime(config, async (_url, init) => {
    if (init?.method === "GET") { assert.ok(carrierRead); return carrierRead(_url, init); }
    carrierRequests++; assert.equal(init?.method, "POST"); form = new URLSearchParams(String(init.body));
    return Response.json({ account_sid: config.accountSid, sid: callSid, to: form.get("To"), from: config.from, direction: "outbound-api", status: "queued",
      parent_call_sid: null, uri: `/2010-04-01/Accounts/${config.accountSid}/Calls/${callSid}.json` }, { status: 201 });
  });
  const provider = runtime.binding(), original = { recallRef: "cliniko:recall:40", attempt: { ...seed.attempt,
    provider: { ref: provider.ref, bindingDigest: provider.bindingDigest }, capacityAllocationRef: randomUUID(),
    dncReferences: { actionRef: randomUUID(), approvalRef: randomUUID() },
    contactReferences: { guardRef: randomUUID(), allocationRef: randomUUID(), outcomeActionRef: randomUUID() } } };
  const payload = { effectRef: original.attempt.effectRef, capacityAllocationRef: original.attempt.capacityAllocationRef, number: "+12025550123", profileRef: provider.profileRef };
  assert.equal((await runtime.launchOnce(payload, new AbortController().signal, async () => true, () => {}, original)).kind, "accepted");
  native.setNow("2026-11-01T10:03:00.000Z");
  const burned = new Map<string, string>(), queries: TwilioOutboundTerminalObservationQuery[] = [];
  const effects = (selectedScope: typeof scope, owner: string): OutboundEffectBarrier => effectsFactory?.(selectedScope, owner) ?? ({
    matches: (s, b) => isDeepStrictEqual(s, selectedScope) && b === owner,
    claimOnce: async ref => {
      const prior = burned.get(ref); if (prior && prior !== owner) return { ok: false, error: { kind: "bindingMismatch" } };
      if (prior) return { ok: true, value: { claimed: false } }; burned.set(ref, owner); return { ok: true, value: { claimed: true } };
    },
  });
  const auth = new TwilioOutboundTerminalObservationAuthentication(key, { ref: provider.ref, bindingDigest: provider.bindingDigest });
  const source = { read: async () => { await state.beforeSource?.(); return { ok: true as const, value: approval }; }, current: () => state.source };
  const record = { allows: async (q: TwilioOutboundTerminalObservationQuery) => { queries.push(q); return state.record && q.authenticationBinding === auth.authenticationBinding(); },
    current: () => state.current, producerAdmitted: async () => state.producer };
  const ports = { source, record, effects, native: native.port }, producer = value(TwilioOutboundTerminalObservationProducer.create({ runtime, observations, key }, ports));
  const request = (patch: Record<string, string> = {}): SignedTwilioWebhook => {
    const url = new URL(form.get("StatusCallback")!), fields = { AccountSid: config.accountSid, CallSid: callSid, From: config.from, To: payload.number,
      Direction: "outbound-api", CallStatus: "completed", ...patch };
    return { method: "POST", requestTarget: url.pathname + url.search, contentType: "application/x-www-form-urlencoded",
      signature: getExpectedTwilioSignature(config.authToken, url.href, fields), body: new URLSearchParams(fields).toString() };
  };
  return { native, observations, key, approval, config, runtime, original, payload, burned, queries, state, source, record, ports, auth, producer, request,
    get carrierRequests() { return carrierRequests; } };
}
