import { ClinikoCallTasks } from "./cliniko-call-tasks.ts";
import { isDeepStrictEqual } from "node:util";
import { completePrivateResendPresentation } from "./private-resend-presentation.ts";
import { randomUUID } from "node:crypto";
import { ClinikoAppointmentReader } from "../cliniko/appointments.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { CallRuntime } from "../core/runtime.ts";
import { err, ok } from "../core/model.ts";
import type { AppointmentRead, Result } from "../core/model.ts";
import { hasSentPatientWork } from "../core/request-boundary.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import type { ConfirmationResendSessionConfig } from "./cliniko-confirmation-resend-session.ts";
import { ClinikoSamConfirmationResendHost } from "./cliniko-sam-confirmation-resend-host.ts";
import { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";

export type ConfirmationResendWorkflowConfig = Pick<ConfirmationResendSessionConfig,
  "policy" | "permission" | "contactRevision" | "journal" | "email" | "presentation"> & Readonly<{ callerApprovalPath: string; taskSequence?: ClinikoCallTasks }>;
type Config = Omit<ClinikoBookingSessionConfig, "callerApprovalPath" | "bookingApprovalPath" | "representative"> & Readonly<{ resend: ConfirmationResendWorkflowConfig }>;
type Failure = Readonly<{ kind: "confirmationResendWorkflowUnavailable" }>;
const unavailable = <T>(): Result<T, Failure> => err({ kind: "confirmationResendWorkflowUnavailable" });
export type ConfirmationResendMenuProgress = Readonly<{ count: number; hasNext: boolean; hasPrevious: boolean }>;
type ResendAppointmentRead = Omit<AppointmentRead, "appointments"> & Readonly<{ appointments: readonly (AppointmentRead["appointments"][number] & { cancelledAt?: string })[] }>;
type Menu = Readonly<{ presentationId: string; conversationRevision: number; from: string; to: string; snapshot: ResendAppointmentRead; offset: number }>;

/** An admitted resend owns a separate verifier and private appointment menu.
 * Public progress contains counts and random request references only. */
export class ClinikoConfirmationResendWorkflow {
  readonly #config: Config;
  readonly #verification: CallerVerificationSession;
  readonly #reader: ClinikoAppointmentReader;
  readonly #runtime: CallRuntime;
  readonly effects: ClinikoSamConfirmationResendHost;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.dispose();
  #menu: Menu | undefined;
  #menuPresentationId: string | undefined;
  #busy = false;
  private constructor(config: Config, verification: CallerVerificationSession, reader: ClinikoAppointmentReader, effects: ClinikoSamConfirmationResendHost) {
    this.#config = config; this.#verification = verification; this.#reader = reader; this.effects = effects;
    this.#runtime = new CallRuntime(config.ledger, config.receipt.scope);
    config.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.signal.aborted) this.dispose();
  }
  static async create(incoming: Config): Promise<Result<ClinikoConfirmationResendWorkflow, Failure>> {
    let verification: CallerVerificationSession | undefined, effects: ClinikoSamConfirmationResendHost | undefined;
    let completed = false;
    const signal = AbortSignal.any([incoming.signal, AbortSignal.timeout(20_000)]);
    try {
      const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound),
        cliniko: Object.freeze({ ...incoming.cliniko }), resend: Object.freeze({ ...incoming.resend }) });
      const building = (async () => {
        const c = config.resend, scope = config.receipt.scope, clock = config.clock ?? (() => new Date().toISOString());
        if (c.taskSequence && (!(c.taskSequence instanceof ClinikoCallTasks) || !c.taskSequence.matches(scope, config.receipt.callId, config.sessionId,
            config.cliniko.businessId, clinikoCredentialFingerprint(config.cliniko.apiKey), config.cliniko.timeZone, config.policyVersion))) return undefined;
        if (config.cliniko.contactRevision !== c.contactRevision || !c.contactRevision.matches(scope.tenantId, clinikoCredentialFingerprint(config.cliniko.apiKey))) return undefined;
        const caller = await OwnerFileCallerPolicy.capture({ path: c.callerApprovalPath, scope, policyVersion: config.policyVersion,
          operation: "appointments.resend", directory: config.directory, clock });
        if (!caller.ok || signal.aborted) return undefined;
        const method = await caller.value.current(scope);
        if (!method.ok || !method.value.enabled || signal.aborted) return undefined;
        const policy = { operation: "appointments.resend" as const, current: async (bound: typeof scope) => {
          const method = await caller.value.current(bound), approval = await c.policy.current(bound), current = await config.policies.read(bound);
          return method.ok ? ok({ ...method.value, enabled: method.value.enabled && approval.ok && current.ok &&
            current.value.policyVersion === config.policyVersion && current.value.capabilities.confirmationResend === "execute" &&
            current.value.confirmationResendVersion === c.policy.bindingFingerprint() }) : method;
        } };
        const verifier = CallerVerificationSession.create({ ...config, operation: "appointments.resend", policyStore: config.policies,
          policy, contact: new ClinikoVerificationContactReader({ ...config.cliniko, scope }, config.fetchPort), permission: c.permission,
          budget: config.verificationBudget, clock });
        if (!verifier.ok) return undefined;
        verification = verifier.value;
        if (signal.aborted) { verification.dispose(); return undefined; }
        // This adapter is private to the resend owner. It does not issue appointments.read authority.
        const reader = ClinikoAppointmentReader.create({ ...config.cliniko, scope }, {
          verifyPatient: (bound, ref, now) => verifier.value.proof.verifyOperation(bound, ref, "appointments.resend", now, config.signal),
        }, config.fetchPort, clock);
        if (!reader.ok) return undefined;
        const host = await ClinikoSamConfirmationResendHost.create({ receipt: config.receipt, inbound: config.inbound,
          sessionId: config.sessionId, policyVersion: config.policyVersion, ledger: config.ledger, policies: config.policies,
          cliniko: config.cliniko, signal: config.signal, clock, ...(config.fetchPort ? { fetchPort: config.fetchPort } : {}),
          policy: c.policy, permission: c.permission, contactRevision: c.contactRevision, presentation: c.presentation,
          journal: c.journal, email: c.email, verification: verifier.value });
        if (!host.ok) return undefined;
        effects = host.value;
        if (signal.aborted) { effects.dispose(); verification.dispose(); return undefined; }
        return new ClinikoConfirmationResendWorkflow(config, verifier.value, reader.value, host.value);
      })();
      const built = await awaitUntilAbort(building, signal);
      if (!built || signal.aborted) { void building.then(late => late?.dispose(), () => undefined); return unavailable(); }
      completed = true; return ok(built);
    } catch { return unavailable(); }
    finally { if (!completed) { effects?.dispose(); verification?.dispose(); } }
  }
  beginVerification() { return this.#verification.begin(); }
  submitCode(code: string) { return this.#verification.submitCode(code); }
  #now() { return (this.#config.clock ?? (() => new Date().toISOString()))(); }
  async #ready(signal: AbortSignal) {
    if (signal.aborted || this.#lifetime.signal.aborted || this.#config.signal.aborted) return undefined;
    const subject = await this.#verification.verifiedSubject("appointments.resend", signal);
    const state = await this.#runtime.read(this.#config.receipt.callId);
    return subject && state.ok && !(this.#config.resend.taskSequence ? this.#config.resend.taskSequence.hasSentCurrentWork(state.value) : hasSentPatientWork(state.value)) && !state.value.callerIdentityDenied &&
      state.value.lifecycle === "active" && state.value.sessionLease?.sessionId === this.#config.sessionId &&
      Date.parse(state.value.sessionLease.expiresAt) > Date.parse(this.#now()) && !signal.aborted ? { subject, state: state.value } : undefined;
  }
  async #showMenu(snapshot: ResendAppointmentRead, from: string, to: string, offset: number, revision: number, signal: AbortSignal): Promise<ConfirmationResendMenuProgress | undefined> {
    const c = this.#config, shown = snapshot.appointments.slice(offset, offset + 3), presentationId = randomUUID();
    const hasNext = offset + shown.length < snapshot.appointments.length, hasPrevious = offset > 0;
    this.#menuPresentationId = presentationId;
    const format = new Intl.DateTimeFormat("en-GB", { timeZone: c.cliniko.timeZone, dateStyle: "full", timeStyle: "short" });
    const text = shown.length ? `Choose the appointment whose details you want emailed. ${shown.map((a, i) => `Press ${i + 1} for: ${format.format(new Date(a.startsAt))}${a.cancelledAt ? ", cancelled" : ""}.`).join(" ")}${hasNext ? " Press 4 for the next appointments." : ""}${hasPrevious ? " Press 5 for the previous appointments." : ""}`
      : "I found no appointments eligible for these emails within the approved search window. No appointment-details email will be sent.";
    const queued = await this.#runtime.privateResendPrompt(c.receipt.callId, presentationId, c.sessionId, this.#now());
    if (!queued.ok || signal.aborted) return undefined;
    const started = await this.#runtime.startPresentation(c.receipt.callId, presentationId, c.sessionId, this.#now());
    if (!started.ok || signal.aborted) return undefined;
    let played = false;
    try { played = await c.resend.presentation.play(text, signal, presentationId) === true && !signal.aborted; } catch { /* No playback proof. */ }
    const resolved = await completePrivateResendPresentation(this.#runtime, c.receipt.callId, presentationId, c.sessionId, played, this.#now());
    const fresh = await this.#ready(signal);
    if (!played || !resolved || !fresh || fresh.state.conversationRevision !== revision) return undefined;
    if (shown.length) this.#menu = { presentationId, conversationRevision: revision, from, to, offset, snapshot: structuredClone(snapshot) };
    return { count: shown.length, hasNext, hasPrevious };
  }
  async #readMenu(anchor: string, to: string, verificationRef: string, now: string, signal: AbortSignal): Promise<ResendAppointmentRead | undefined> {
    const c = this.#config, approval = await c.resend.policy.current(c.receipt.scope);
    if (!approval.ok || signal.aborted) return undefined;
    const active = await this.#reader.list(c.receipt.scope, verificationRef, now, to, now);
    if (!active.ok || active.value.timeZone !== c.cliniko.timeZone) return undefined;
    const options: ResendAppointmentRead["appointments"][number][] = approval.value.template === "appointmentDetails.v2" &&
      !approval.value.contentKinds?.some(kind => kind === "activeInPerson" || kind === "activeTelehealth") ? [] : [...active.value.appointments];
    if (approval.value.template === "appointmentDetails.v2" && approval.value.contentKinds?.includes("cancelled")) {
      // The lookback follows the current clock; a renewed call must not make an old anchor exceed the native history bound.
      const past = new Date(Date.parse(now) - 90 * 86_400_000).toISOString();
      for (const [from, end] of [[past, anchor], [anchor, to]]) {
        if (signal.aborted) return undefined;
        const cancelled = await this.#reader.listCancelled(c.receipt.scope, verificationRef, from!, end!, now);
        if (!cancelled.ok || cancelled.value.timeZone !== active.value.timeZone || cancelled.value.sourceRef !== active.value.sourceRef) return undefined;
        for (const row of cancelled.value.appointments) {
          const duplicate = options.find(a => a.appointmentRef === row.appointmentRef);
          if (duplicate && !isDeepStrictEqual(duplicate, row)) return undefined;
          if (!duplicate) options.push(row);
        }
      }
    }
    options.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.appointmentRef.localeCompare(b.appointmentRef));
    if (new Set(options.map(a => `${a.startsAt}:${a.cancelledAt ? "cancelled" : "active"}`)).size !== options.length || signal.aborted) return undefined;
    return { ...active.value, appointments: options };
  }
  async listAppointments(external = this.#config.signal): Promise<Result<ConfirmationResendMenuProgress, Failure>> {
    if (this.#busy) return unavailable();
    this.#busy = true; this.#menu = undefined; this.#menuPresentationId = undefined;
    const signal = AbortSignal.any([external, this.#config.signal, this.#lifetime.signal, AbortSignal.timeout(30_000)]);
    try {
      const prepared = await awaitUntilAbort((async () => {
        const before = await this.#ready(signal); if (!before || !this.effects.discardPreparation()) return undefined;
        const now = this.#now(), to = new Date(Date.parse(now) + 90 * 86_400_000).toISOString();
        const read = await this.#readMenu(now, to, before.subject.verificationRef, now, signal);
        const after = await this.#ready(signal);
        if (!read || !after || after.state.conversationRevision !== before.state.conversationRevision) return undefined;
        return this.#showMenu(read, now, to, 0, before.state.conversationRevision, signal);
      })(), signal);
      return prepared && !signal.aborted ? ok(prepared) : unavailable();
    } catch { return unavailable(); }
    finally { this.#busy = false; }
  }
  async pageAppointments(direction: "next" | "previous", external = this.#config.signal): Promise<Result<ConfirmationResendMenuProgress, Failure>> {
    const menu = this.#menu;
    const offset = menu ? menu.offset + (direction === "next" ? 3 : -3) : -1;
    if (this.#busy || !menu || !["next", "previous"].includes(direction) || offset < 0 || offset >= menu.snapshot.appointments.length) return unavailable();
    this.#busy = true; this.#menu = undefined; this.#menuPresentationId = undefined;
    const signal = AbortSignal.any([external, this.#config.signal, this.#lifetime.signal, AbortSignal.timeout(30_000)]);
    try {
      const paged = await awaitUntilAbort((async () => {
        const before = await this.#ready(signal);
        if (!before || before.state.conversationRevision !== menu.conversationRevision || before.state.pendingPresentationId ||
            before.state.presentations[menu.presentationId]?.status !== "played" || before.subject.verificationRef !== menu.snapshot.verificationRef || !this.effects.discardPreparation()) return undefined;
        const now = this.#now(), read = await this.#readMenu(menu.from, menu.to, before.subject.verificationRef, now, signal);
        const after = await this.#ready(signal);
        if (!read || !after || after.state.conversationRevision !== menu.conversationRevision || read.sourceRef !== menu.snapshot.sourceRef ||
            read.timeZone !== menu.snapshot.timeZone || !isDeepStrictEqual(read.appointments, menu.snapshot.appointments)) return undefined;
        return this.#showMenu(read, menu.from, menu.to, offset, menu.conversationRevision, signal);
      })(), signal);
      return paged && !signal.aborted ? ok(paged) : unavailable();
    } catch { return unavailable(); }
    finally { this.#busy = false; }
  }
  async menuPlaybackCompleted(): Promise<boolean> {
    const id = this.#menuPresentationId;
    if (!id || this.#lifetime.signal.aborted || this.#config.signal.aborted) return false;
    const state = await this.#runtime.read(this.#config.receipt.callId);
    return state.ok && state.value.lifecycle === "active" && state.value.sessionLease?.sessionId === this.#config.sessionId &&
      state.value.presentations[id]?.status === "played";
  }
  async selectAppointment(choice: 1 | 2 | 3, external = this.#config.signal): Promise<Result<Readonly<{ requestRef: string }>, Failure>> {
    const menu = this.#menu;
    if (this.#busy || !menu || ![1, 2, 3].includes(choice) || !menu.snapshot.appointments[menu.offset + choice - 1] || choice > Math.min(3, menu.snapshot.appointments.length - menu.offset)) return unavailable();
    this.#busy = true; this.#menu = undefined;
    const signal = AbortSignal.any([external, this.#config.signal, this.#lifetime.signal, AbortSignal.timeout(30_000)]);
    try {
      const result = await awaitUntilAbort((async () => {
        const before = await this.#ready(signal);
        if (!before || before.state.conversationRevision !== menu.conversationRevision || before.state.presentations[menu.presentationId]?.status !== "played" || before.state.pendingPresentationId ||
            before.subject.verificationRef !== menu.snapshot.verificationRef) return undefined;
        const now = this.#now(), target = menu.snapshot.appointments[menu.offset + choice - 1]!;
        const fresh = await this.#readMenu(menu.from, menu.to, before.subject.verificationRef, now, signal);
        const after = await this.#ready(signal);
        const match = fresh ? fresh.appointments.filter(a => a.appointmentRef === target.appointmentRef) : [];
        if (!fresh || !after || after.state.conversationRevision !== before.state.conversationRevision ||
            fresh.sourceRef !== menu.snapshot.sourceRef || fresh.timeZone !== menu.snapshot.timeZone || match.length !== 1 ||
            !isDeepStrictEqual(match[0], target)) return undefined;
        return this.effects.prepare(target.appointmentRef, signal);
      })(), signal);
      return result?.ok && !signal.aborted ? result : unavailable();
    } catch { return unavailable(); }
    finally { this.#busy = false; }
  }
  dispose(): void { this.#menu = undefined; this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose); this.effects.dispose(); this.#verification.dispose(); }
}
