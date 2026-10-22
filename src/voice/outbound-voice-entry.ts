import { createHash } from "node:crypto";
import type { MediaTurnOptions } from "./media-turn-controller.ts";
import type { StreamedPlaybackOptions } from "./streamed-playback-port.ts";
import type { LedgerStore } from "../core/ledger.ts";
import type { ModelKnowledgeContextHost } from "../core/host.ts";
import { validGreetingAt, validGreetingShape } from "../core/greeting.ts";
import { validVoiceLocationScope, validVoicePolicy } from "../core/voice-profile.ts";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, CallPolicy, LocationScope, ProviderCallKey, Result, TransitionFailure } from "../core/model.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { callIdFor } from "./admission.ts";
import type { RouteFailure } from "./admission.ts";
import { prepareVoiceAdmissionPolicy } from "./approved-admission-policy.ts";
import { closeAdmittedCall } from "./unattached-call-close.ts";
import type { VoiceCallEntry } from "./voice-call-entry.ts";

/** Public authenticated selection only. Called number/native subject stay in the
 * provider owner's volatile closure; neither is a patient verification grant. */
export type OutboundConversationCall = Readonly<{
  key: ProviderCallKey; scope: LocationScope; clinicNumber: string; profileRef: string;
}>;
export type OutboundConversationApproval = Readonly<{
  purpose: "outboundContact";
  /** Optional physical stop-producer/source/key/recognizer selection. Absence
   * preserves the existing profile projection; it proves no stop coverage. */
  stopSpeechBinding?: string;
  /** Separate optional provider-notification producer selection. A profile
   * without this field grants no new native terminal-observation producer. */
  terminalObservationBinding?: string;
  /** Separate explicit no-answer provenance producer; never inherited by older profiles. */
  unansweredCallObservationBinding?: string;
  policy: CallPolicy;
  /** Trusted physical host's model/runtime configuration, in addition to the
   * speech profile's own fully validated primary/fallback configuration hash. */
  runtimeConfigurationHash: string;
  mediaOptions?: MediaTurnOptions;
  playbackOptions?: StreamedPlaybackOptions;
}>;
export type OutboundConversationPolicySource = Readonly<{
  read(call: OutboundConversationCall, signal: AbortSignal): Promise<Result<OutboundConversationApproval, Readonly<{ kind: "unavailable" }>>>;
  /** Independent current clinic/profile/source/restore approval, never a claim
   * supplied by model output or by the recipient answering the telephone. */
  current(call: OutboundConversationCall, approval: OutboundConversationApproval): boolean;
}>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Captures effective approved speech/greeting and the actual host's model
 * configuration. A human profile name is insufficient for cold correlation. */
export function outboundConversationProfileRef(approval: OutboundConversationApproval): string | undefined {
  try {
    const { policy, runtimeConfigurationHash } = approval;
    if (approval.purpose !== "outboundContact" || !/^[a-f0-9]{64}$/.test(runtimeConfigurationHash) ||
        approval.stopSpeechBinding !== undefined && !/^[a-f0-9]{64}$/.test(approval.stopSpeechBinding) ||
        approval.terminalObservationBinding !== undefined && !/^[a-f0-9]{64}$/.test(approval.terminalObservationBinding) ||
        approval.unansweredCallObservationBinding !== undefined && !/^[a-f0-9]{64}$/.test(approval.unansweredCallObservationBinding) ||
        !policy || !validVoicePolicy(policy, policy.scope) || !policy.voiceProfile ||
        !validGreetingShape(policy.greeting, policy.scope) ||
        !policy.greeting.effectiveFrom || !policy.greeting.effectiveUntil ||
        typeof policy.policyVersion !== "string" || !policy.policyVersion ||
        typeof policy.automationVersion !== "string" || !policy.automationVersion) return;
    const projection = { version: 1, scope: policy.scope, policyVersion: policy.policyVersion, automationVersion: policy.automationVersion,
      voiceSettings: policy.voiceSettings, voiceProfile: policy.voiceProfile, greeting: policy.greeting, runtimeConfigurationHash,
      mediaOptions: approval.mediaOptions ?? {}, playbackOptions: approval.playbackOptions ?? {},
      ...(approval.stopSpeechBinding !== undefined ? { stopSpeechBinding: approval.stopSpeechBinding } : {}),
      ...(approval.terminalObservationBinding !== undefined ? { terminalObservationBinding: approval.terminalObservationBinding } : {}),
      ...(approval.unansweredCallObservationBinding !== undefined ? { unansweredCallObservationBinding: approval.unansweredCallObservationBinding } : {}) };
    return `abby-outbound-v1:${createHash("sha256").update(JSON.stringify(canonical(projection))).digest("hex")}`;
  } catch { return; }
}
function validCall(call: OutboundConversationCall): boolean {
  return !!call && Object.keys(call).sort().join(",") === "clinicNumber,key,profileRef,scope" &&
    !!call.key && Object.keys(call.key).sort().join(",") === "accountRef,providerCallRef" &&
    [call.key.accountRef, call.key.providerCallRef].every(v => typeof v === "string" && !!v.trim() && v.length <= 256) &&
    validVoiceLocationScope(call.scope) && /^\+[1-9][0-9]{7,14}$/.test(call.clinicNumber) &&
    /^abby-outbound-v1:[a-f0-9]{64}$/.test(call.profileRef);
}
const unready = (): Result<never, RouteFailure> => err({ kind: "readinessFailed" });

/** Prepares under the ingress startup deadline before creating speech adapters.
 * Local session closure remains unrelated to complete provider/contact truth. */
export async function prepareOutboundVoiceEntry(config: Readonly<{
  call: OutboundConversationCall; ledger: LedgerStore; source: OutboundConversationPolicySource;
  readiness: AutomationReadiness; now: () => string; signal: AbortSignal; knowledge?: ModelKnowledgeContextHost;
}>): Promise<Result<VoiceCallEntry, RouteFailure | TransitionFailure>> {
  try {
    const call = freeze(structuredClone(config.call));
    if (!validCall(call) || config.signal.aborted) return unready();
    const loaded = await awaitUntilAbort(config.source.read(call, config.signal), config.signal);
    if (!loaded?.ok) return unready();
    const approval = structuredClone(loaded.value), profileRef = outboundConversationProfileRef(approval);
    if (profileRef !== call.profileRef || !validVoiceLocationScope(approval.policy.scope) ||
        JSON.stringify([approval.policy.scope.tenantId, approval.policy.scope.clinicId, approval.policy.scope.locationId]) !==
        JSON.stringify([call.scope.tenantId, call.scope.clinicId, call.scope.locationId])) return unready();
    freeze(approval);
    const current = () => {
      try { return !config.signal.aborted && validGreetingAt(approval.policy.greeting, call.scope, config.now()) &&
        config.source.current(call, approval) === true; } catch { return false; }
    };
    if (!current()) return unready();
    const prepared = await awaitUntilAbort(prepareVoiceAdmissionPolicy(approval.policy, config.readiness, config.now, config.knowledge), config.signal);
    if (!prepared?.ok || !current() || outboundConversationProfileRef({ ...approval, policy: prepared.value.policy }) !== profileRef) return unready();
    const { policy, acceptedAt } = prepared.value, callId = callIdFor(call.key);
    let receipt: AdmissionReceipt | undefined;
    return ok({ callId, key: call.key, current,
      begin: async () => {
        const at = Date.parse(config.now());
        if (!current() || !Number.isFinite(at) || at < Date.parse(acceptedAt) || at >= Date.parse(acceptedAt) + 30_000) return unready();
        const admitted = await config.ledger.admit(callId, policy, { direction: "outbound", key: call.key,
          clinicNumber: call.clinicNumber, acceptedAt, deadline: new Date(Date.parse(acceptedAt) + 30_000).toISOString() });
        if (admitted.ok) receipt = admitted.value.receipt;
        return admitted.ok && current() ? ok({ kind: "admitted", admission: admitted.value }) : admitted.ok ? unready() : admitted;
      },
      closeUnattached: (known, sessionId, now, reason) => {
        const selected = known ?? receipt;
        return selected ? closeAdmittedCall({ ledger: config.ledger, receipt: selected, sessionId, now, reason })
          : Promise.resolve(err({ kind: "callUnknown" }));
      },
    });
  } catch { return unready(); }
}
