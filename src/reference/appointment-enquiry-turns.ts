import type { AppointmentEnquiryHost, AppointmentEnquiryQuery } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err } from "../core/model.ts";
import type { CallState, FinalCallerTurn, LocationScope, Result, TransitionFailure, TurnInterpretation } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import { noticePresentationId } from "../core/transition.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

/** Read-only turns share SAM/playback gates, but issue no clinical proposal or exposed proof. */
export class AppointmentEnquiryTurns {
  readonly #ledger: LedgerStore;
  readonly #host: Partial<AppointmentEnquiryHost>;
  constructor(ledger: LedgerStore, host: Partial<AppointmentEnquiryHost>) { this.#ledger = ledger; this.#host = host; }
  enabled(): boolean { return typeof this.#host.readAppointmentEnquiry === "function" && typeof this.#host.selectAppointmentEnquiry === "function"; }
  async accept(scope: LocationScope, turn: FinalCallerTurn, request: Readonly<{ from: string; to: string }> | Readonly<{ choice: 1 | 2 | 3 }>,
    now: string, expectedRevision?: number, external?: AbortSignal): Promise<Result<CallState, TransitionFailure>> {
    const current = await this.#ledger.read(turn.callId, scope);
    if (!current.ok) return current;
    const state = current.value;
    if (state.lifecycle !== "active" || turn.quality !== "clear" || !turn.sessionId || state.sessionLease?.sessionId !== turn.sessionId ||
        Date.parse(state.sessionLease.expiresAt) <= Date.parse(now) || expectedRevision !== undefined && state.conversationRevision !== expectedRevision)
      return err({ kind: "staleTurn" });
    if (state.processedTurnIds.includes(turn.turnId)) return current;
    const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
    const query: AppointmentEnquiryQuery = { scope, callId: turn.callId, sessionId: turn.sessionId, policyVersion: state.policy.policyVersion!,
      expectedConversationRevision: state.conversationRevision, now, signal };
    let interpretation: TurnInterpretation = { kind: "appointmentsFailure", reason: "notConfigured" };
    try {
      if ("choice" in request) {
        const last = state.appointmentReads.at(-1);
        const presentation = last ? state.presentations[noticePresentationId(turn.callId, last.turnId)] : undefined;
        if (!last || last.status !== "shown" || (last.shownCount ?? 0) < 2 || state.processedTurnIds.at(-1) !== last.turnId ||
            state.pendingPresentationId || presentation?.status !== "played" || ![1, 2, 3].includes(request.choice)) {
          interpretation = { kind: "appointmentsFailure", reason: "notFound" };
        } else {
          const selected = await awaitUntilAbort(this.#host.selectAppointmentEnquiry?.({ ...query, ...request }) ?? Promise.resolve(undefined), signal);
          interpretation = !selected ? { kind: "appointmentsFailure", reason: "unavailable" } : !selected.ok
            ? { kind: "appointmentsFailure", reason: selected.error.kind } : selected.value.snapshot.appointments.length !== 1
              ? { kind: "appointmentsFailure", reason: "malformed" } : { kind: "appointments", ...selected.value, declareRange: true };
        }
      } else {
        const read = await awaitUntilAbort(this.#host.readAppointmentEnquiry?.({ ...query, ...request }) ?? Promise.resolve(undefined), signal);
        interpretation = !read ? { kind: "appointmentsFailure", reason: "unavailable" } : read.ok
          ? { kind: "appointments", ...request, snapshot: read.value, declareRange: true } : { kind: "appointmentsFailure", reason: read.error.kind };
      }
    } catch { interpretation = { kind: "appointmentsFailure", reason: "unavailable" }; }
    if (signal.aborted) return err({ kind: "staleTurn" });
    return new CallRuntime(this.#ledger, scope).acceptTurn(turn, interpretation, now, state.conversationRevision);
  }
}
