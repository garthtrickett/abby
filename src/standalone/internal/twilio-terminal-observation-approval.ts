import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../../core/model.ts";
import type { LocationScope, Result } from "../../core/model.ts";
import { awaitUntilAbort } from "../../shared/await-until-abort.ts";
import { outboundConversationProfileRef } from "../../voice/outbound-voice-entry.ts";
import type { OutboundConversationPolicySource } from "../../voice/outbound-voice-entry.ts";
import type { AuthenticatedTwilioOutboundCall } from "../../voice/twilio-outbound-runtime.ts";

function freeze<T>(v: T): T { if (v && typeof v === "object") { for (const x of Object.values(v)) freeze(x); Object.freeze(v); } return v; }

/** Private shared admission of the original explicit notification profile.
 * The owning purpose supplies its one deadline and live runtime/clock guard.
 * This reads approval only: it neither authenticates caller-supplied events nor
 * grants a native write, delivery ACK, closure or contact/clinical result. */
export async function readTerminalObservationApproval(source: OutboundConversationPolicySource, call: AuthenticatedTwilioOutboundCall,
  expected: Readonly<{ scope: LocationScope; profileRef: string; terminalBinding: string; bindingField?: "terminalObservationBinding" | "unansweredCallObservationBinding" }>, signal: AbortSignal, selected: () => boolean):
  Promise<Result<Readonly<{ current(): boolean }>, Readonly<{ kind: "unavailable" | "forbidden" }>>> {
  try {
    const read = source.read.bind(source), live = source.current.bind(source), choice = freeze(structuredClone(expected));
    const selection = freeze({ key: { accountRef: call.accountSid, providerCallRef: call.callSid }, scope: choice.scope,
      clinicNumber: call.clinicNumber, profileRef: choice.profileRef });
    if (signal.aborted || !selected()) return err({ kind: "unavailable" });
    const loaded = await awaitUntilAbort(Promise.resolve().then(() => selected() ? read(selection, signal) : err({ kind: "unavailable" as const })), signal);
    if (!loaded?.ok || signal.aborted || !selected()) return err({ kind: "unavailable" });
    const approval = freeze(structuredClone(loaded.value));
    const current = () => !signal.aborted && selected() && approval[choice.bindingField ?? "terminalObservationBinding"] === choice.terminalBinding &&
      outboundConversationProfileRef(approval) === choice.profileRef && isDeepStrictEqual(approval.policy.scope, choice.scope) &&
      live(selection, approval) === true && selected();
    return current() ? ok(Object.freeze({ current })) : err({ kind: "forbidden" });
  } catch { return err({ kind: "unavailable" }); }
}
