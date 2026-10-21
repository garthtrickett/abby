import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { SignedTwilioWebhook } from "../voice/twilio-signed-ingress.ts";
import { TwilioAbbyOutboundRuntime } from "../voice/twilio-outbound-runtime.ts";
import { ClinikoTwilioOutboundNotificationDelivery } from "./cliniko-twilio-outbound-notification-delivery.ts";
import { ClinikoTwilioOutboundStopRecovery } from "./cliniko-twilio-outbound-stop-recovery.ts";
import { NativeRequestAllowance } from "./internal/native-request-allowance.ts";

type Config = Readonly<{
  notifications: Readonly<{ config: Parameters<typeof ClinikoTwilioOutboundNotificationDelivery.create>[0]; ports: Parameters<typeof ClinikoTwilioOutboundNotificationDelivery.create>[1] }>;
  stop: Readonly<{ config: Parameters<typeof ClinikoTwilioOutboundStopRecovery.create>[0]; ports: Parameters<typeof ClinikoTwilioOutboundStopRecovery.create>[1] }>;
  maximumNativeRequests: number; deadlineMs?: number;
}>;
type Failure = Readonly<{ kind: "invalidConfig" | "unavailable" | "forbidden" }>;

/** One signed delivery, one cumulative allowance and one deadline. Restrictive
 * stop recovery runs first. Completed provenance may be acknowledged with
 * absent speech evidence, without converting that absence into no-stop truth. */
export class TwilioOutboundStatusDelivery {
  readonly #authenticate: TwilioAbbyOutboundRuntime["authenticateStatus"];
  readonly #runtime: TwilioAbbyOutboundRuntime;
  readonly #notifications: ClinikoTwilioOutboundNotificationDelivery;
  readonly #stop: ClinikoTwilioOutboundStopRecovery;
  readonly #maximum: number;
  readonly #deadline: number;
  private constructor(runtime: TwilioAbbyOutboundRuntime, notifications: ClinikoTwilioOutboundNotificationDelivery,
    stop: ClinikoTwilioOutboundStopRecovery, maximum: number, deadline: number) {
    this.#runtime = runtime; this.#notifications = notifications; this.#stop = stop; this.#maximum = maximum; this.#deadline = deadline;
    this.#authenticate = runtime.authenticateStatus.bind(runtime);
  }
  static create(c: Config): Result<TwilioOutboundStatusDelivery, Failure> {
    try {
      const n = c.notifications.config, s = c.stop.config, physical = n.observations.rateBudget;
      const deadline = c.deadlineMs ?? 5000;
      if (!Number.isSafeInteger(c.maximumNativeRequests) || c.maximumNativeRequests < 1 || c.maximumNativeRequests > 180 ||
          !Number.isSafeInteger(deadline) || deadline < 1 || deadline > 10000 || n.runtime !== c.stop.ports.runtime ||
          [n.attempts, s.stop.requests, s.stop.attempts, s.stop.dnc.source, s.reports].some(v => v.rateBudget !== physical ||
            v.apiKey !== n.observations.apiKey || v.businessId !== n.observations.businessId || !isDeepStrictEqual(v.scope, n.observations.scope)) ||
          n.attempts.outboundAttemptRecallTypeId !== s.stop.attempts.outboundAttemptRecallTypeId ||
          [s.stop.requests.outboundRecallTypeId, s.stop.attempts.outboundAttemptRecallTypeId, s.stop.dnc.source.contactReviewRecallTypeId,
            s.reports.outboundProviderReportRecallTypeId].includes(n.observations.outboundTerminalObservationRecallTypeId)) return err({ kind: "invalidConfig" });
      const notifications = ClinikoTwilioOutboundNotificationDelivery.create(n, c.notifications.ports), stop = ClinikoTwilioOutboundStopRecovery.create(s, c.stop.ports);
      return notifications.ok && stop.ok ? ok(new TwilioOutboundStatusDelivery(n.runtime, notifications.value, stop.value, c.maximumNativeRequests, deadline)) : err({ kind: "invalidConfig" });
    } catch { return err({ kind: "invalidConfig" }); }
  }
  matchesRuntime(runtime: TwilioAbbyOutboundRuntime): boolean {
    return this.#notifications.matchesRuntime(runtime) && this.#stop.matchesRuntime(runtime);
  }
  async receiveStatus(request: SignedTwilioWebhook, external: AbortSignal): Promise<Result<Readonly<{ kind: "acknowledged" }>, Failure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const controller = new AbortController(), signal = AbortSignal.any([external, controller.signal]), began = performance.now();
    const timer = setTimeout(() => controller.abort(), this.#deadline), allowance = new NativeRequestAllowance(this.#maximum);
    const current = () => !signal.aborted && performance.now() - began <= this.#deadline && this.matchesRuntime(this.#runtime);
    try {
      const raw = Object.freeze(structuredClone(request)), authenticated = this.#authenticate(raw);
      if (!authenticated.ok || !current()) return err({ kind: "forbidden" });
      const status = authenticated.value.status;
      if (!["completed", "busy", "failed", "no-answer", "canceled"].includes(status)) return ok({ kind: "acknowledged" });
      const recovered = await awaitUntilAbort(this.#stop.recoverStatusEvidence(raw, signal, allowance), signal);
      if (!current() || !recovered?.ok || recovered.value.outcome.kind === "uncertain" ||
          recovered.value.evidence === "stop" && recovered.value.outcome.kind === "unresolved" ||
          status !== "completed" && recovered.value.evidence === "missing") return err({ kind: "unavailable" });
      if (status === "completed") {
        const notification = await awaitUntilAbort(this.#notifications.receiveStatus(raw, signal, allowance), signal);
        if (!notification?.ok || notification.value.kind !== "notificationRetained" || !current()) return err({ kind: "unavailable" });
      }
      return ok({ kind: "acknowledged" });
    } catch { return err({ kind: "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
