import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoCallFlow } from "./cliniko-call-flow.ts";
import type { RepresentativeIdentity } from "./cliniko-representative-selection.ts";
import { RepresentativeCallerSources } from "./representative-caller-sources.ts";
import type { RepresentativeCallerContext, RepresentativeCallerMethod, RepresentativeInputConfig } from "./representative-caller-sources.ts";

type Operation = "book" | "cancel" | "reschedule" | "appointments.read";
type Config = RepresentativeInputConfig & Readonly<{ context: RepresentativeCallerContext; flow: ClinikoCallFlow; operation: Operation;
  serviceChoice?: import("../core/booking-service-choice.ts").BookingServiceChoice }>;
type Failure = Readonly<{ kind: "representativeUnavailable" }>;
const denied = <T>(): Result<T, Failure> => err({ kind: "representativeUnavailable" });
const patientOperation = { book: "appointments.book", cancel: "appointments.cancel", reschedule: "appointments.reschedule", "appointments.read": "appointments.read" } as const;

/** Call-owned private identity choice and verification. The selected caller
 * source never becomes the patient's proof or supplies subject permission. */
export class ClinikoRepresentativeCallOwner {
  readonly #config: Config;
  readonly #sources: RepresentativeCallerSources;
  #method: RepresentativeCallerMethod | undefined;
  readonly #lifetime: AbortController;
  readonly #onClose = () => this.dispose();
  #busy = false;
  #attempted = false;
  #routed = false;
  private constructor(config: Config, sources: RepresentativeCallerSources, lifetime: AbortController) {
    this.#config = config; this.#sources = sources; this.#lifetime = lifetime;
    const methods = sources.methods(); this.#method = methods.length === 1 ? methods[0] : undefined;
    config.context.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.context.signal.aborted) this.dispose();
  }
  static async create(incoming: Config): Promise<Result<ClinikoRepresentativeCallOwner, Failure>> {
    const lifetime = new AbortController();
    let sources: RepresentativeCallerSources | undefined;
    let completed: ClinikoRepresentativeCallOwner | undefined;
    try {
      if (!incoming || !(incoming.flow instanceof ClinikoCallFlow) || !(incoming.context?.signal instanceof AbortSignal) ||
          incoming.context.signal.aborted || incoming.context.receipt.admission.direction === "outbound" || !Object.hasOwn(patientOperation, incoming.operation) ||
          !incoming.flow.matchesPrivateVerificationContext(incoming.context)) return denied();
      const context = Object.freeze({ ...incoming.context, receipt: structuredClone(incoming.context.receipt), inbound: structuredClone(incoming.context.inbound),
        cliniko: Object.freeze({ ...incoming.context.cliniko }), clock: incoming.context.clock ?? (() => new Date().toISOString()),
        signal: AbortSignal.any([incoming.context.signal, lifetime.signal]) });
      const config = Object.freeze({ ...incoming, context, ...(incoming.serviceChoice ? { serviceChoice: structuredClone(incoming.serviceChoice) } : {}) });
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]);
      sources = new RepresentativeCallerSources(config, context, patientOperation[config.operation], () => config.flow.matchesPrivateVerificationContext(context));
      const ownedSources = sources;
      const building = (async () => {
        if (!await ownedSources.prepare(signal) || signal.aborted || !config.flow.matchesPrivateVerificationContext(context)) return undefined;
        return new ClinikoRepresentativeCallOwner(config, ownedSources, lifetime);
      })();
      const built = await awaitUntilAbort(building, signal);
      if (!built || signal.aborted) { void building.then(late => late?.dispose(), () => undefined); return denied(); }
      completed = built; return ok(built);
    } catch { return denied(); }
    finally { if (!completed) { lifetime.abort(); sources?.dispose(); } }
  }
  get closed(): boolean { return this.#lifetime.signal.aborted; }
  get operation(): Operation { return this.#config.operation; }
  binding() { return { callId: this.#config.context.receipt.callId, sessionId: this.#config.context.sessionId }; }
  async privateStartupReady(): Promise<boolean> {
    const c = this.#config.context, state = await c.ledger.read(c.receipt.callId, c.receipt.scope);
    return !this.closed && this.#config.flow.matchesPrivateVerificationContext(c) && state.ok && !state.value.callerIdentityDenied &&
      !state.value.pendingPresentationId && Object.values(state.value.presentations).every(item => item.status !== "started" && item.status !== "possiblySent");
  }
  get callerMethodChoiceRequired(): boolean { return !this.closed && this.#method === undefined && this.#sources.methods().length === 2; }
  chooseCallerMethod(method: RepresentativeCallerMethod): boolean {
    if (this.closed || this.#method !== undefined || !this.#config.flow.matchesPrivateVerificationContext(this.#config.context) || !this.#sources.retain(method)) return false;
    this.#method = method; return true;
  }
  beginCallerVerification(): boolean {
    const source = this.#method && this.#sources.source(this.#method);
    if (this.closed || !source || !this.#config.flow.matchesPrivateVerificationContext(this.#config.context)) return false;
    source.actor.begin(); return true;
  }
  async submitCallerCode(code: string): Promise<Readonly<{ verified: boolean }>> {
    const source = this.#method && this.#sources.source(this.#method);
    if (this.closed || !source || !this.#config.flow.matchesPrivateVerificationContext(this.#config.context)) return { verified: false };
    const result = await source.actor.submitCode(code);
    return !this.closed && this.#config.flow.matchesPrivateVerificationContext(this.#config.context) ? result : { verified: false };
  }
  beginPatientVerification(): boolean {
    return !this.closed && this.#routed && this.#config.flow.matchesPrivateVerificationContext(this.#config.context) && this.#config.flow.beginVerification();
  }
  async selectPatient(identity: RepresentativeIdentity, expectedRevision?: number, external?: AbortSignal): Promise<Result<Readonly<{ codeRequired: true }>, Failure>> {
    const source = this.#method && this.#sources.source(this.#method);
    if (this.closed || !source || this.#busy || this.#attempted || external?.aborted || !this.#config.flow.matchesPrivateVerificationContext(this.#config.context)) return denied();
    this.#busy = true; this.#attempted = true;
    const signal = AbortSignal.any([this.#config.context.signal, this.#lifetime.signal, AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
    try {
      const selected = await source.selection.select(structuredClone(identity), patientOperation[this.#config.operation], signal);
      if (!selected.ok || signal.aborted || !this.#config.flow.matchesPrivateVerificationContext(this.#config.context)) return denied();
      const routed = await this.#config.flow.chooseRepresentative(this.#config.operation, { owner: source.selection, selectionRef: selected.value.selectionRef }, signal, expectedRevision, this.#config.serviceChoice);
      this.#routed = routed.ok && !signal.aborted && !this.closed;
      return this.#routed ? ok({ codeRequired: true as const }) : denied();
    } catch { return denied(); }
    finally { this.#busy = false; }
  }
  dispose(): void {
    this.#config.context.signal.removeEventListener("abort", this.#onClose); this.#lifetime.abort(); this.#sources.dispose();
  }
}
