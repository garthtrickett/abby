import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { outboundLaunchAttemptDigest } from "../cliniko/outbound-launch-attempt.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { ClinikoTwilioOutboundTerminalHistory } from "../cliniko/twilio-outbound-terminal-history.ts";
import type { TwilioTerminalHistoryAuthority } from "../cliniko/twilio-outbound-terminal-history.ts";
import { TwilioOutboundTerminalObservationAuthentication } from "../cliniko/twilio-outbound-terminal-observation.ts";
import { TwilioAbbyOutboundRuntime } from "../voice/twilio-outbound-runtime.ts";
import type { SignedTwilioWebhook } from "../voice/twilio-signed-ingress.ts";
import { TwilioOutboundTerminalObservationProducer, twilioTerminalObservationProfileBinding } from "./twilio-outbound-terminal-observation.ts";
import { readTerminalObservationApproval } from "./internal/twilio-terminal-observation-approval.ts";
import { NativeRequestAllowance } from "./internal/native-request-allowance.ts";

type ProducerConfig = Parameters<typeof TwilioOutboundTerminalObservationProducer.create>[0];
type ProducerPorts = Parameters<typeof TwilioOutboundTerminalObservationProducer.create>[1];
type AttemptConfig = Parameters<typeof ClinikoTwilioOutboundTerminalHistory.create>[0]["attempts"];
export type TwilioNotificationDeliveryConfig = ProducerConfig & Readonly<{ attempts: AttemptConfig; maximumNativeRequests: number }>;
export type TwilioNotificationDeliveryPorts = ProducerPorts & Readonly<{ history: TwilioTerminalHistoryAuthority }>;
type Failure = Readonly<{ kind: "invalidConfig" | "unavailable" | "forbidden" }>;
type Outcome = Readonly<{ kind: "notificationRetained" | "ignoredStatus" }>;
type HistoryQuery = Parameters<TwilioTerminalHistoryAuthority["current"]>[0];

/** Delivery ACK only. A known native ACK or independently permitted exact cold
 * native observation establishes retention. Unretained uncertainty cannot retry
 * a spent purpose. This exposes neither hold owner nor a closure/contact port;
 * HTTP delivery acknowledgement never establishes a call/clinical result. */
export class ClinikoTwilioOutboundNotificationDelivery {
  readonly #config: TwilioNotificationDeliveryConfig;
  readonly #ports: TwilioNotificationDeliveryPorts;
  readonly #selected: ReturnType<TwilioAbbyOutboundRuntime["binding"]>;
  readonly #binding: TwilioAbbyOutboundRuntime["binding"];
  readonly #authenticate: TwilioAbbyOutboundRuntime["authenticateStatus"];
  readonly #accepts: TwilioAbbyOutboundRuntime["acceptsAccount"];
  readonly #auth: TwilioOutboundTerminalObservationAuthentication;
  readonly #profile: string;
  private constructor(c: TwilioNotificationDeliveryConfig, p: TwilioNotificationDeliveryPorts, auth: TwilioOutboundTerminalObservationAuthentication, profile: string) {
    const b = c.observations.rateBudget, budget = Object.freeze({ claim: b.claim.bind(b), observe429: b.observe429.bind(b),
      ...(b.checkHeadroom ? { checkHeadroom: b.checkHeadroom.bind(b) } : {}) });
    this.#config = Object.freeze({ ...c, key: Buffer.from(c.key), observations: Object.freeze({ ...c.observations, scope: Object.freeze({ ...c.observations.scope }), rateBudget: budget,
      ...(c.observations.clock ? { clock: c.observations.clock.bind(c.observations) } : {}) }),
      attempts: Object.freeze({ ...c.attempts, scope: Object.freeze({ ...c.attempts.scope }), rateBudget: budget, ...(c.attempts.clock ? { clock: c.attempts.clock.bind(c.attempts) } : {}) }) });
    this.#ports = Object.freeze({ source: Object.freeze({ read: p.source.read.bind(p.source), current: p.source.current.bind(p.source) }),
      record: Object.freeze({ allows: p.record.allows.bind(p.record), current: p.record.current.bind(p.record), producerAdmitted: p.record.producerAdmitted.bind(p.record) }),
      effects: p.effects.bind(p), native: p.native ?? fetch,
      history: Object.freeze({ allowsHistoryRead: p.history.allowsHistoryRead.bind(p.history), allowsObservationRead: p.history.allowsObservationRead.bind(p.history),
        allowsAttemptRead: p.history.allowsAttemptRead.bind(p.history), current: p.history.current.bind(p.history) }) });
    this.#selected = Object.freeze({ ...c.runtime.binding() }); this.#binding = c.runtime.binding.bind(c.runtime);
    this.#authenticate = c.runtime.authenticateStatus.bind(c.runtime); this.#accepts = c.runtime.acceptsAccount.bind(c.runtime); this.#auth = auth; this.#profile = profile;
  }
  static create(c: TwilioNotificationDeliveryConfig, p: TwilioNotificationDeliveryPorts): Result<ClinikoTwilioOutboundNotificationDelivery, Failure> {
    try {
      if (!(c.runtime instanceof TwilioAbbyOutboundRuntime) || !Number.isSafeInteger(c.maximumNativeRequests) || c.maximumNativeRequests < 1 || c.maximumNativeRequests > 180 ||
          !TwilioOutboundTerminalObservationProducer.create(c, p).ok) return err({ kind: "invalidConfig" });
      const provider = c.runtime.binding(), auth = new TwilioOutboundTerminalObservationAuthentication(c.key, { ref: provider.ref, bindingDigest: provider.bindingDigest });
      const history = ClinikoTwilioOutboundTerminalHistory.create({ observations: c.observations, attempts: c.attempts }, auth, p.history, p.native), profile = twilioTerminalObservationProfileBinding(c.observations, c.key);
      return history.ok && profile ? ok(new ClinikoTwilioOutboundNotificationDelivery(c, p, auth, profile)) : err({ kind: "invalidConfig" });
    } catch { return err({ kind: "invalidConfig" }); }
  }
  matchesRuntime(runtime: TwilioAbbyOutboundRuntime): boolean {
    try { return runtime instanceof TwilioAbbyOutboundRuntime && isDeepStrictEqual(runtime.binding(), this.#selected) && isDeepStrictEqual(this.#binding(), this.#selected); }
    catch { return false; }
  }
  async receiveStatus(request: SignedTwilioWebhook, external: AbortSignal, allowance?: NativeRequestAllowance): Promise<Result<Outcome, Failure>> {
    if (!(external instanceof AbortSignal) || external.aborted || allowance !== undefined && !(allowance instanceof NativeRequestAllowance)) return err({ kind: "unavailable" });
    const c = this.#config, p = this.#ports, controller = new AbortController(), ms = Math.min(c.observations.deadlineMs ?? 15000, c.attempts.deadlineMs ?? 15000);
    const signal = AbortSignal.any([external, controller.signal]), timer = setTimeout(() => controller.abort(), ms), began = performance.now();
    try {
      const raw = Object.freeze(structuredClone(request)), decoded = this.#authenticate(raw);
      if (!decoded.ok || !this.matchesRuntime(c.runtime)) return err({ kind: "forbidden" });
      const event = structuredClone(decoded.value), call = event.call, a = call.context.original.attempt;
      if (event.status !== "completed") return ok({ kind: "ignoredStatus" });
      if (!a.capacityAllocationRef || !this.#accepts(call.accountSid)) return err({ kind: "forbidden" });
      let last = call.receivedAt;
      const selected = () => { const now = c.observations.clock?.() ?? new Date().toISOString();
        if (signal.aborted || performance.now() - began > ms || typeof now !== "string" || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now || now < last || !this.matchesRuntime(c.runtime)) return false;
        last = now; return true;
      };
      const admitted = await readTerminalObservationApproval(p.source, call, { scope: a.scope, profileRef: this.#selected.profileRef, terminalBinding: this.#profile }, signal, selected);
      if (!admitted.ok) return admitted;
      const current = admitted.value.current, physical = c.observations.rateBudget; let claims = 0;
      const budget: ClinikoRequestBudget = Object.freeze({ claim: () => !current() || ++claims > c.maximumNativeRequests || allowance && !allowance.take() ? { kind: "unavailable" as const } : physical.claim(),
        observe429: physical.observe429.bind(physical), ...(physical.checkHeadroom ? { checkHeadroom: (n: number) => !current() || claims + n > c.maximumNativeRequests || allowance && !allowance.hasHeadroom(n) ? { kind: "unavailable" as const } : physical.checkHeadroom!(n) } : {}) });
      const observations = { ...c.observations, rateBudget: budget }, attempts = { ...c.attempts, rateBudget: budget };
      const producer = TwilioOutboundTerminalObservationProducer.create({ runtime: c.runtime, observations, key: c.key }, p);
      if (!producer.ok || !current()) return err({ kind: "unavailable" });
      const retained = await awaitUntilAbort(producer.value.observeStatus(raw, signal), signal);
      if (!current() || !retained) return err({ kind: "unavailable" });
      if (retained.ok && retained.value.kind === "accepted") return ok({ kind: "notificationRetained" });
      // Retention recovery is separately read-authorized. A denied/spent writer
      // never grants that read, and native absence never authorizes another POST.
      const grants = new Map<string, HistoryQuery>();
      const readable = () => current() && [...grants.values()].every(q => p.history.current(q, signal) === true);
      const history = ClinikoTwilioOutboundTerminalHistory.create({ observations, attempts }, this.#auth, { ...p.history, current: (q, s) => {
        const key = q.operation + ":" + ("recallRef" in q ? q.recallRef : "account") + ":" + ("observation" in q && !!q.observation || "attempt" in q && !!q.attempt);
        grants.set(key, q); return readable() && p.history.current(q, s) === true;
      } }, p.native);
      if (!history.ok || !readable()) return err({ kind: "unavailable" });
      const found = await awaitUntilAbort(history.value.findForRuntime({ effectRef: a.effectRef, capacityAllocationRef: a.capacityAllocationRef }, call.accountSid, signal), signal);
      if (!found?.ok || !found.value.evidence || !readable()) return err({ kind: "unavailable" });
      const e = found.value.evidence, v = e.observation.record;
      if (v.callSid !== call.callSid || !this.#auth.matchesOriginal(v, call.context, call.accountSid) ||
          outboundLaunchAttemptDigest(e.original.attempt) !== call.context.attemptDigest || e.original.recallRef !== call.context.original.recallRef) return err({ kind: "forbidden" });
      return ok({ kind: "notificationRetained" });
    } catch { return err({ kind: "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
