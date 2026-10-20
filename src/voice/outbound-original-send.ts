import { isDeepStrictEqual } from "node:util";
import { decodeOutboundLaunchAttempt, encodeOutboundLaunchAttempt } from "../cliniko/outbound-launch-attempt.ts";
import type { OutboundLaunchAttempt } from "../cliniko/outbound-launch-attempt.ts";
import type { OutboundProviderBinding, OutboundRuntimeCall } from "./outbound-runtime.ts";

/** Private volatile workflow handoff, supplied only after the native possible
 * attempt ACK. It grants neither a read nor clinical authority. An adapter may
 * seal it for provider-owned cold correlation; never journal it in local SQL. */
export type OutboundOriginalSend = Readonly<{ recallRef: string; attempt: OutboundLaunchAttempt }>;

export function captureOutboundOriginalSend(input: OutboundOriginalSend, call: OutboundRuntimeCall,
  provider: OutboundProviderBinding): OutboundOriginalSend | undefined {
  try {
    input = structuredClone(input);
    if (!input || Object.keys(input).sort().join(",") !== "attempt,recallRef" ||
        !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(input.recallRef)) return;
    const encoded = encodeOutboundLaunchAttempt(input.attempt);
    if (!encoded.ok) return;
    const decoded = decodeOutboundLaunchAttempt(encoded.value);
    if (!decoded.ok || decoded.value.effectRef !== call.effectRef || decoded.value.capacityAllocationRef !== call.capacityAllocationRef ||
        !isDeepStrictEqual(decoded.value.provider, { ref: provider.ref, bindingDigest: provider.bindingDigest })) return;
    return Object.freeze({ recallRef: input.recallRef, attempt: decoded.value });
  } catch { return; }
}
