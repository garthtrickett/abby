import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { digestActionRequest } from "../core/digest.ts";
import { confirmationResendEvidenceFailure } from "../core/confirmation-resend.ts";
import type { ConfirmationResendAction } from "../core/confirmation-resend.ts";
import type { BookingEvidenceHost, ConfirmationResendEvidenceHost, ConfirmationResendEvidenceQuery, HostEffects } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { HostMutation, HostWriteReceipt, ReconcileObservation, StaffItem, StaffTaskObservation, StaffTaskReceipt } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { ClinikoConfirmationResendSession } from "./cliniko-confirmation-resend-session.ts";
import type { ConfirmationResendSessionConfig } from "./cliniko-confirmation-resend-session.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";

type Config = Omit<ConfirmationResendSessionConfig, "isConfirmed" | "ledger"> & Readonly<{ ledger: LedgerStore }>;
/** Native dispatch is authorized by actual SAM state, never a caller/model consent boolean. */
export class ClinikoSamConfirmationResendHost extends NoStoredKnowledge implements HostEffects, ConfirmationResendEvidenceHost {
  readonly effectDeadlineMs = 30_000;
  readonly #config: Config;
  readonly #runtime: CallRuntime;
  #session: ClinikoConfirmationResendSession | undefined;
  #request: ConfirmationResendAction | undefined;
  #dispatch: HostMutation | undefined;
  #receipt: HostWriteReceipt | undefined;
  #closed = false;
  private constructor(config: Config) { super(); this.#config = config; this.#runtime = new CallRuntime(config.ledger, config.receipt.scope); }
  static async create(incoming: Config) {
    const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound), cliniko: Object.freeze({ ...incoming.cliniko }) });
    const host = new ClinikoSamConfirmationResendHost(config);
    const session = await ClinikoConfirmationResendSession.create({ ...config,
      presentation: { play: (text, signal) => host.#play(text, signal) }, isConfirmed: (ref, signal) => host.#confirmed(ref, signal) });
    if (!session.ok || !await host.#ready(config.signal)) { session.ok && session.value.dispose(); host.#closed = true; return err({ kind: "confirmationResendUnavailable" as const }); }
    host.#session = session.value; return ok(host);
  }
  #now(): string { return (this.#config.clock ?? (() => new Date().toISOString()))(); }
  async #ready(signal: AbortSignal): Promise<boolean> {
    const c = this.#config, scope = c.receipt.scope;
    if (this.#closed || signal.aborted || c.signal.aborted) return false;
    const policy = await c.policies.read(scope), approval = await c.policy.current(scope), stop = await c.ledger.readWriteStop(scope);
    const state = await this.#runtime.read(c.receipt.callId), now = Date.parse(this.#now()), version = c.policy.bindingFingerprint();
    return policy.ok && approval.ok && stop.ok && !stop.value.stopped && state.ok && Number.isFinite(now) &&
      sameScope(policy.value.scope, scope) && policy.value.automationEnabled && policy.value.policyVersion === c.policyVersion &&
      policy.value.capabilities.confirmationResend === "execute" && policy.value.confirmationResendVersion === version &&
      state.value.lifecycle === "active" && !state.value.callerIdentityDenied && sameScope(state.value.policy.scope, scope) && state.value.policy.automationEnabled &&
      state.value.policy.policyVersion === c.policyVersion && state.value.policy.capabilities.confirmationResend === "execute" && state.value.policy.confirmationResendVersion === version &&
      state.value.sessionLease?.sessionId === c.sessionId && Date.parse(state.value.sessionLease.expiresAt) > now &&
      state.value.admission?.key.accountRef === c.inbound.key.accountRef && state.value.admission.key.providerCallRef === c.inbound.key.providerCallRef &&
      state.value.admission.dialedNumber === c.inbound.dialedNumber && !signal.aborted && !c.signal.aborted && !this.#closed;
  }
  async #play(text: string, signal: AbortSignal): Promise<boolean> {
    const c = this.#config, ref = randomUUID();
    if (!await this.#ready(signal)) return false;
    const queued = await this.#runtime.privateResendPrompt(c.receipt.callId, ref, c.sessionId, this.#now());
    if (!queued.ok || signal.aborted) return false;
    const started = await this.#runtime.startPresentation(c.receipt.callId, ref, c.sessionId, this.#now());
    if (!started.ok || signal.aborted) return false;
    let played = false;
    try { played = await c.presentation.play(text, signal) === true && !signal.aborted; } catch { /* No playback proof. */ }
    const resolved = await this.#runtime.resolvePresentation(c.receipt.callId, ref, played ? "played" : "failed", c.sessionId, this.#now());
    return resolved.ok && played && await this.#ready(signal);
  }
  async prepare(appointmentId: string) {
    if (this.#dispatch || !this.#session || !await this.#ready(this.#config.signal)) return err({ kind: "confirmationResendUnavailable" as const });
    this.#request = undefined;
    const prepared = await this.#session.prepare(appointmentId);
    if (!prepared.ok) return prepared;
    const proof = await this.#config.verification.verifiedSubject("appointments.resend", this.#config.signal), now = Date.parse(this.#now());
    if (!proof || !Number.isFinite(now) || !await this.#ready(this.#config.signal)) return err({ kind: "confirmationResendUnavailable" as const });
    this.#request = { kind: "confirmationResend", scope: structuredClone(this.#config.receipt.scope), requestRef: prepared.value.requestRef,
      resendVersion: this.#config.policy.bindingFingerprint(), expiresAt: new Date(Math.min(Date.parse(proof.expiresAt), now + 120_000)).toISOString() };
    return ok({ requestRef: prepared.value.requestRef });
  }
  async resolveConfirmationResend(query: ConfirmationResendEvidenceQuery): ReturnType<ConfirmationResendEvidenceHost["resolveConfirmationResend"]> {
    const c = this.#config, request = this.#request;
    const signal = AbortSignal.any([c.signal, AbortSignal.timeout(20_000)]);
    if (!request || this.#dispatch || !sameScope(query.scope, c.receipt.scope) || query.callId !== c.receipt.callId || query.sessionId !== c.sessionId ||
        query.policyVersion !== c.policyVersion || query.requestRef !== request.requestRef || Math.abs(Date.parse(query.now) - Date.parse(this.#now())) > 30_000 ||
        !await this.#ready(signal) || !await this.#session?.current(request.requestRef, signal)) return err({ kind: "unavailable", target: "patient" });
    const state = await this.#runtime.read(c.receipt.callId);
    return state.ok && !confirmationResendEvidenceFailure(state.value.policy, request, query.now) ? ok(structuredClone(request)) : err({ kind: "unavailable", target: "patient" });
  }
  #matches(mutation: HostMutation): boolean {
    return mutation.kind === "confirmationResend" && mutation.request.kind === "confirmationResend" && !!this.#request &&
      sameScope(mutation.scope, this.#config.receipt.scope) && mutation.policyVersion === this.#config.policyVersion &&
      isDeepStrictEqual(mutation.request, this.#request) && mutation.payloadDigest === digestActionRequest(mutation.request) && mutation.notification === undefined;
  }
  async #confirmed(requestRef: string, signal: AbortSignal): Promise<boolean> {
    const mutation = this.#dispatch;
    if (!mutation || this.#request?.requestRef !== requestRef || !this.#matches(mutation) || !await this.#ready(signal)) return false;
    const state = await this.#runtime.read(this.#config.receipt.callId);
    if (!state.ok) return false;
    const action = state.value.actions[mutation.actionKey], effect = state.value.effects[`${mutation.actionKey}:write`], presentation = action && state.value.presentations[action.presentationId];
    return action?.kind === "confirmationResend" && action.status === "dispatched" && action.digest === mutation.payloadDigest &&
      isDeepStrictEqual(action.mutation, mutation) && effect?.kind === "hostWrite" && effect.status === "possiblySent" && isDeepStrictEqual(effect.mutation, mutation) &&
      presentation?.kind === "speech" && presentation.status === "played" && presentation.actionKey === action.key && presentation.digest === action.digest &&
      !confirmationResendEvidenceFailure(state.value.policy, mutation.request as ConfirmationResendAction, this.#now()) && !signal.aborted;
  }
  async write(mutation: HostMutation, now: string, external = this.#config.signal): Promise<HostWriteReceipt> {
    if (!this.#matches(mutation) || !Number.isFinite(Date.parse(now)) || Math.abs(Date.parse(now) - Date.parse(this.#now())) > 30_000) return { kind: "rejected", actionKey: mutation.actionKey, reason: "invalid" };
    if (this.#dispatch) return isDeepStrictEqual(mutation, this.#dispatch) && this.#receipt ? structuredClone(this.#receipt) :
      { kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now, deadline: new Date(Date.parse(now) + 86_400_000).toISOString() };
    this.#dispatch = structuredClone(mutation);
    if (!await this.#confirmed(this.#request!.requestRef, external) || !this.#session) return { kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" };
    const result = await this.#session.dispatch(this.#request!.requestRef, external);
    this.#receipt = result.kind === "accepted" ? { kind: "committed", actionKey: mutation.actionKey, hostRef: `confirmation-mail:${result.messageRef}` }
      : result.kind === "denied" || result.kind === "definitiveUnsent" ? { kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" }
        : { kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now, deadline: new Date(Date.parse(now) + 86_400_000).toISOString() };
    return structuredClone(this.#receipt);
  }
  async reconcile(mutation: HostMutation): Promise<ReconcileObservation> {
    if (!this.#matches(mutation) || !this.#dispatch || !isDeepStrictEqual(mutation, this.#dispatch)) return { kind: "stillUnknown", actionKey: mutation.actionKey };
    const stored = await this.#config.journal.read(this.#request!.requestRef);
    return stored.ok && stored.value?.kind === "accepted" && stored.value.messageRef === this.#request!.requestRef
      ? { kind: "exactCommit", actionKey: mutation.actionKey, hostRef: `confirmation-mail:${stored.value.messageRef}` }
      : stored.ok && stored.value?.kind === "definitiveUnsent" ? { kind: "definitiveNonCommit", actionKey: mutation.actionKey } : { kind: "stillUnknown", actionKey: mutation.actionKey };
  }
  async openTask(item: StaffItem): Promise<StaffTaskReceipt> { return { kind: "rejected", taskKey: item.key }; }
  async resolveBooking(): ReturnType<BookingEvidenceHost["resolveBooking"]> {
    return err({ kind: "unavailable", target: "patient" });
  }
  async reconcileTask(item: StaffItem): Promise<StaffTaskObservation> { return { kind: "stillUnknown", taskKey: item.key }; }
  dispose(): void { this.#closed = true; this.#session?.dispose(); this.#request = undefined; }
}
