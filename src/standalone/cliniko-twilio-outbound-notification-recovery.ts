import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err } from "../core/model.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { ClinikoTwilioOutboundTerminalHistory } from "../cliniko/twilio-outbound-terminal-history.ts";
import type { TwilioTerminalHistoryAuthority } from "../cliniko/twilio-outbound-terminal-history.ts";
import { TwilioOutboundTerminalObservationAuthentication, twilioOutboundTerminalObservationDigest } from "../cliniko/twilio-outbound-terminal-observation.ts";
import type { TwilioOutboundTerminalObservationConfig } from "../cliniko/twilio-outbound-terminal-observation-records.ts";
import type { OutboundLaunchRecord } from "../cliniko/outbound-launch-records.ts";
import { TwilioAbbyOutboundRuntime } from "../voice/twilio-outbound-runtime.ts";
import type { TwilioNotificationClosureAuthority, TwilioNotificationClosureQuery } from "../voice/twilio-outbound-notification-closure.ts";
import { ClinikoOutboundTerminalOwner } from "./cliniko-outbound-terminal-owner.ts";
import type { OutboundTerminalConfig } from "./cliniko-outbound-terminal-owner.ts";

type CallPorts = Parameters<typeof ClinikoOutboundTerminalOwner.create>[1];
export type TwilioNotificationRecoveryConfig = Readonly<{ call: OutboundTerminalConfig; observations: TwilioOutboundTerminalObservationConfig }>;
export type TwilioNotificationRecoveryPorts = Readonly<{ runtime: TwilioAbbyOutboundRuntime;
  authentication: TwilioOutboundTerminalObservationAuthentication; history: TwilioTerminalHistoryAuthority;
  closure: TwilioNotificationClosureAuthority; call: Omit<CallPorts, "provider" | "native">; native: typeof fetch }>;
type HistoryQuery = Parameters<TwilioTerminalHistoryAuthority["current"]>[0];

/** Capacity-only cold recovery through the existing replaceable provider port.
 * Native notification provenance selects a call; independent all-source/restore
 * provider approval and actual complete root/child reads establish its end.
 * Current original, native verifier/source and provider grants fence the actual
 * capacity mutation after all waits. No contact port, writes, launch, private
 * journal, speech/no-stop inference or default route exists in this composition. */
export async function recoverTwilioOutboundNotification(c: TwilioNotificationRecoveryConfig, p: TwilioNotificationRecoveryPorts,
  input: Parameters<ClinikoOutboundTerminalOwner["inspectAndRelease"]>[0], external: AbortSignal):
  ReturnType<ClinikoOutboundTerminalOwner["inspectAndRelease"]> {
  if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = AbortSignal.any([external, controller.signal]);
  try {
    const a = c.call.attempts, o = c.observations, physical = a.rateBudget, ms = c.call.deadlineMs ?? 30000;
    if (!(p.runtime instanceof TwilioAbbyOutboundRuntime) || !(p.authentication instanceof TwilioOutboundTerminalObservationAuthentication) ||
        !isDeepStrictEqual(p.authentication.binding(), { ref: p.runtime.binding().ref, bindingDigest: p.runtime.binding().bindingDigest }) ||
        o.rateBudget !== physical || o.apiKey !== a.apiKey || o.businessId !== a.businessId || !isDeepStrictEqual(o.scope, a.scope) ||
        !Number.isSafeInteger(ms) || ms < 1 || ms > 120000) return err({ kind: "invalidConfig" });
    timer = setTimeout(() => controller.abort(), ms);
    const selected = Object.freeze({ ...p.runtime.binding() }), binding = p.runtime.binding.bind(p.runtime), accepts = p.runtime.acceptsAccount.bind(p.runtime);
    const reader = p.runtime.createNotificationClosureReader(), accountSid = reader.accountSid();
    const historyAuthority = Object.freeze({ allowsHistoryRead: p.history.allowsHistoryRead.bind(p.history), allowsObservationRead: p.history.allowsObservationRead.bind(p.history),
      allowsAttemptRead: p.history.allowsAttemptRead.bind(p.history), current: p.history.current.bind(p.history) });
    const closureAuthority = Object.freeze({ allows: p.closure.allows.bind(p.closure), current: p.closure.current.bind(p.closure) });
    const record = Object.freeze({ allows: p.call.record.allows.bind(p.call.record), current: p.call.record.current.bind(p.call.record) });
    const authority = Object.freeze({ allows: p.call.authority.allows.bind(p.call.authority), current: p.call.authority.current.bind(p.call.authority) });
    const nativeGrants = new Map<string, HistoryQuery>(), providerGrants = new Map<string, TwilioNotificationClosureQuery>();
    const current = () => !signal.aborted && isDeepStrictEqual(binding(), selected) && accepts(accountSid) &&
      [...nativeGrants.values()].every(q => historyAuthority.current(q, signal) === true) && [...providerGrants.values()].every(q => closureAuthority.current(q, signal) === true);
    const claim = physical.claim.bind(physical), observe429 = physical.observe429.bind(physical), headroom = physical.checkHeadroom?.bind(physical); let claims = 0;
    const maximum = c.call.maximumNativeRequests;
    const budget: ClinikoRequestBudget = Object.freeze({ claim: () => !current() || ++claims > maximum ? { kind: "unavailable" as const } : claim(), observe429,
      ...(headroom ? { checkHeadroom: (n: number) => !current() || claims + n > maximum ? { kind: "unavailable" as const } : headroom(n) } : {}) });
    const attempts = { ...a, scope: Object.freeze({ ...a.scope }), rateBudget: budget, ...(a.clock ? { clock: a.clock.bind(a) } : {}) };
    const observations = { ...o, scope: Object.freeze({ ...o.scope }), rateBudget: budget, ...(o.clock ? { clock: o.clock.bind(o) } : {}) };
    const history = ClinikoTwilioOutboundTerminalHistory.create({ attempts, observations }, p.authentication, { ...historyAuthority, current: (q, s) => {
      const key = q.operation + ":" + ("recallRef" in q ? q.recallRef : "account") + ":" + ("observation" in q && !!q.observation || "attempt" in q && !!q.attempt);
      nativeGrants.set(key, q); return current() && historyAuthority.current(q, s) === true;
    } }, p.native);
    if (!history.ok) return err({ kind: "invalidConfig" });
    let original: OutboundLaunchRecord | undefined;
    const owner = ClinikoOutboundTerminalOwner.create({ ...c.call, attempts }, { ...p.call, native: p.native,
      record: { allows: record.allows, current: (q, s) => current() && record.current(q, s) === true },
      authority: { allows: authority.allows, current: (q, s) => {
        if (original && !isDeepStrictEqual(original, q.record)) return false;
        original ??= q.record; return current() && authority.current(q, s) === true;
      } }, provider: { binding: () => Object.freeze({ ref: selected.ref, bindingDigest: selected.bindingDigest }),
        inspectTerminal: async (identity, sourceSignal) => {
          const first = await history.value.findForRuntime(identity, accountSid, sourceSignal);
          if (!first.ok || !first.value.evidence || !current()) return { kind: "unknown" };
          const evidence = first.value.evidence, notification = evidence.observation.record;
          if (!original || !isDeepStrictEqual(evidence.original, original)) return { kind: "unknown" };
          const closure = await reader.inspect({ callSid: notification.callSid, number: notification.number, attemptedAt: evidence.original.attempt.attemptedAt,
            notifiedAt: notification.receivedAt, evidenceDigest: createHash("sha256").update(JSON.stringify([notification.original.digest,
              twilioOutboundTerminalObservationDigest(notification)])).digest("hex") }, { allows: closureAuthority.allows,
            current: (q, s) => { providerGrants.set(q.operation, q); return current() && closureAuthority.current(q, s) === true; } }, sourceSignal);
          if (closure.kind !== "singleRootClosed" || !current()) return { kind: closure.kind === "active" ? "active" : "unknown" };
          const again = await history.value.findForRuntime(identity, accountSid, sourceSignal);
          if (!again.ok || !isDeepStrictEqual(again.value.evidence, evidence) || !current()) return { kind: "unknown" };
          return Object.freeze({ kind: "terminal", complete: true, ...identity, provider: Object.freeze({ ref: selected.ref, bindingDigest: selected.bindingDigest }),
            endedAt: closure.endedAt, observedAt: closure.observedAt });
        } } });
    return owner.ok ? await owner.value.inspectAndRelease(Object.freeze(structuredClone(input)), signal) : err({ kind: "invalidConfig" });
  } catch { return err({ kind: "unavailable" }); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}
