import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { validRecallMarker } from "../cliniko/recall-note.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { captureOutboundOriginalSend } from "./outbound-original-send.ts";
import type { OutboundOriginalSend } from "./outbound-original-send.ts";

/** Non-patient selection. bindingDigest must cover transport account, runtime,
 * credentials and effective profile/settings. A different runtime needs a new
 * binding and current clinic approval; a name alone is not an identity. */
export type OutboundProviderBinding = Readonly<{ ref: string; bindingDigest: string; profileRef: string }>;
export type OutboundTerminalProviderBinding = Readonly<{ ref: string; bindingDigest: string }>;
export type OutboundRuntimeCall = Readonly<{ effectRef: string; capacityAllocationRef: string; number: string; profileRef: string }>;
export type OutboundRuntimeCallIdentity = Readonly<{ effectRef: string; capacityAllocationRef: string }>;
export type OutboundRuntimeLaunchResult = Readonly<{ kind: "accepted" | "definitiveUnsent" | "unknown"; effectRef?: string }>;
export type OutboundRuntimeTerminalResult = Readonly<{ kind: "unknown" | "active" }> | Readonly<{
  kind: "terminal"; complete: true; effectRef: string; capacityAllocationRef: string;
  provider: OutboundTerminalProviderBinding; endedAt: string; observedAt: string;
}>;
export type OutboundLaunchProvider = Readonly<{
  binding(): OutboundProviderBinding;
  /** Invoke beforeSend after all internal waits, immediately before the only
   * dispatch. A true fence is one-use, not a retry/idempotency permission.
   * Only an exact parsed provider ACK can call acknowledged. */
  launchOnce(payload: OutboundRuntimeCall, signal: AbortSignal, beforeSend: () => Promise<boolean>,
    acknowledged: (effectRef: string) => void, original?: OutboundOriginalSend): Promise<OutboundRuntimeLaunchResult>;
}>;
export type OutboundTerminalProvider = Readonly<{
  binding(): OutboundTerminalProviderBinding;
  /** Trusted authenticated complete truth for ALL calls with this exact pair.
   * Raw callbacks, silence, missing rows or one ended leg are insufficient.
   * The adapter owns provider lookup/correlation; no local private call map. */
  inspectTerminal(identity: OutboundRuntimeCallIdentity, signal: AbortSignal): Promise<OutboundRuntimeTerminalResult>;
}>;
/** One implementation owns launch and authenticated recovery together. Twilio
 * plus Abby and Twilio plus a hosted runtime implement this same interface.
 * Conversation tools still enter Abby's independent verification/consent/action
 * owners; no model output, transcript or runtime report grants clinical rights. */
export type OutboundVoiceRuntimeAdapter = OutboundLaunchProvider & Pick<OutboundTerminalProvider, "inspectTerminal">;
export type BoundOutboundVoiceRuntime = Readonly<{ launch: OutboundLaunchProvider; terminal: OutboundTerminalProvider }>;
const opaque = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
const exact = (v: unknown, keys: readonly string[]) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const bindingValid = (v: OutboundProviderBinding) => exact(v, ["ref", "bindingDigest", "profileRef"]) && opaque(v.ref) && opaque(v.profileRef) && /^[a-f0-9]{64}$/.test(v.bindingDigest);
const identityValid = (v: OutboundRuntimeCallIdentity) => validRecallMarker(v.effectRef) && validRecallMarker(v.capacityAllocationRef) && v.effectRef !== v.capacityAllocationRef;
const instant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

/** Select once; hand these two ports to the existing workflow owners. No
 * provider registry, implicit fallback, durable private state or default route.
 * This guards the interface; a trusted concrete adapter must still authenticate
 * ACKs/results and implement truthful native correlation and speech evidence. */
export function bindOutboundVoiceRuntime(adapter: OutboundVoiceRuntimeAdapter): Result<BoundOutboundVoiceRuntime, Readonly<{ kind: "invalidConfig" }>> {
  try {
    if ([adapter.binding, adapter.launchOnce, adapter.inspectTerminal].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
    const binding = adapter.binding.bind(adapter), launch = adapter.launchOnce.bind(adapter), inspect = adapter.inspectTerminal.bind(adapter);
    const selected = Object.freeze(structuredClone(binding())); if (!bindingValid(selected)) return err({ kind: "invalidConfig" });
    const terminalBinding = Object.freeze({ ref: selected.ref, bindingDigest: selected.bindingDigest });
    const current = () => { try { return isDeepStrictEqual(binding(), selected); } catch { return false; } };
    const selectedBinding = () => { if (!current()) throw new Error("Outbound runtime selection changed"); return selected; };
    const launchPort: OutboundLaunchProvider = Object.freeze({ binding: selectedBinding,
      async launchOnce(input: OutboundRuntimeCall, signal: AbortSignal, beforeSend: () => Promise<boolean>, acknowledged: (ref: string) => void, original?: OutboundOriginalSend): Promise<OutboundRuntimeLaunchResult> {
        let admitted = false, fenced = false, acceptedRef: string | undefined, closed = false;
        try {
          if (!(signal instanceof AbortSignal) || signal.aborted || !current() || typeof beforeSend !== "function" || typeof acknowledged !== "function" ||
              !exact(input, ["effectRef", "capacityAllocationRef", "number", "profileRef"]) || !identityValid(input) || input.profileRef !== selected.profileRef ||
              typeof input.number !== "string" || !/^\+[1-9][0-9]{7,14}$/.test(input.number)) return { kind: "definitiveUnsent" };
          const payload = Object.freeze(structuredClone(input));
          const context = original === undefined ? undefined : captureOutboundOriginalSend(original, payload, selected);
          if (original !== undefined && !context) return { kind: "definitiveUnsent" };
          const fence = async () => {
            if (closed || fenced || signal.aborted || !current()) return false; fenced = true;
            try {
              const permitted = await awaitUntilAbort(Promise.resolve().then(() =>
                !closed && !signal.aborted && current() ? beforeSend() : false), signal);
              admitted = permitted === true && !closed && !signal.aborted && current(); return admitted;
            } catch { return false; }
          };
          const ack = (ref: string) => {
            if (!closed && admitted && ref === payload.effectRef && !acceptedRef) {
              acceptedRef = ref; acknowledged(ref);
            }
          };
          const answer = await awaitUntilAbort(Promise.resolve().then(() =>
            !signal.aborted && current() ? launch(payload, signal, fence, ack, context) : { kind: "unknown" as const }), signal);
          if (acceptedRef) return { kind: "accepted", effectRef: acceptedRef };
          if (admitted && exact(answer, ["kind", "effectRef"]) && answer?.kind === "accepted" && answer.effectRef === payload.effectRef)
            return { kind: "accepted", effectRef: payload.effectRef };
          // Once invoked, adapter refusal/error/timeout is conservative. The
          // workflow's SQL exclusions and independently proven terminal release
          // remain authoritative; this wrapper does not deduplicate or retry.
          return { kind: "unknown" };
        } catch { return acceptedRef ? { kind: "accepted", effectRef: acceptedRef } : { kind: "unknown" }; }
        finally { closed = true; }
      } });
    const terminalPort: OutboundTerminalProvider = Object.freeze({ binding: () => { selectedBinding(); return terminalBinding; },
      async inspectTerminal(input: OutboundRuntimeCallIdentity, signal: AbortSignal): Promise<OutboundRuntimeTerminalResult> {
        try {
          if (!(signal instanceof AbortSignal) || signal.aborted || !current() || !exact(input, ["effectRef", "capacityAllocationRef"]) || !identityValid(input)) return { kind: "unknown" };
          const identity = Object.freeze(structuredClone(input));
          const answer = await awaitUntilAbort(Promise.resolve().then(() =>
            !signal.aborted && current() ? inspect(identity, signal) : { kind: "unknown" as const }), signal);
          if (signal.aborted || !current() || !answer) return { kind: "unknown" };
          const copy = structuredClone(answer);
          if (exact(copy, ["kind"]) && (copy.kind === "unknown" || copy.kind === "active")) return Object.freeze(copy);
          if (copy.kind !== "terminal" || !exact(copy, ["kind", "complete", "effectRef", "capacityAllocationRef", "provider", "endedAt", "observedAt"]) ||
              copy.complete !== true || copy.effectRef !== identity.effectRef || copy.capacityAllocationRef !== identity.capacityAllocationRef ||
              !isDeepStrictEqual(copy.provider, terminalBinding) || !instant(copy.endedAt) || !instant(copy.observedAt) || copy.endedAt > copy.observedAt) return { kind: "unknown" };
          return Object.freeze({ ...copy, provider: terminalBinding });
        } catch { return { kind: "unknown" }; }
      } });
    return ok(Object.freeze({ launch: launchPort, terminal: terminalPort }));
  } catch { return err({ kind: "invalidConfig" }); }
}
