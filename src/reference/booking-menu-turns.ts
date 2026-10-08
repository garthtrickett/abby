import { normalizedSpokenName } from "../core/pending-location.ts";
import { copyBookingSearchWindow, sameBookingSearchWindow, validBookingSearchWindow } from "../core/booking-search-window.ts";
import type { BookingEvidenceHost, BookingMenuHost, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err } from "../core/model.ts";
import type { CallState, FinalCallerTurn, LocationScope, Result, TransitionFailure, TurnInterpretation } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import { noticePresentationId } from "../core/transition.ts";

type Host = BookingEvidenceHost & Partial<BookingMenuHost>;
type Failure = TransitionFailure | Readonly<{ kind: "effectFailure" }>;
export const bookingMenuDeadlineMs = 15_000;
async function untilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  let stop: () => void = () => undefined;
  const stopped = new Promise<undefined>(resolve => { stop = () => resolve(undefined); signal.addEventListener("abort", stop); if (signal.aborted) stop(); });
  try { return await Promise.race([pending, stopped]); } finally { signal.removeEventListener("abort", stop); }
}

/** Both agent commands use real SAM turns/presentation receipts, with private host selection state. */
export class BookingMenuTurns {
  private readonly ledger: LedgerStore; private readonly policies: PolicyStore; private readonly host: Host; private readonly clock: (() => string) | undefined;
  constructor(ledger: LedgerStore, policies: PolicyStore, host: Host, clock?: () => string) { this.ledger = ledger; this.policies = policies; this.host = host; this.clock = clock; }
  enabled(): boolean { return this.host.bookingMenuAvailable?.() === true && !!this.host.readBookingMenu && !!this.host.selectBookingMenu; }
  async #ready(scope: LocationScope, turn: FinalCallerTurn, now: string, signal: AbortSignal): Promise<Result<CallState, Failure>> {
    const runtime = new CallRuntime(this.ledger, scope), state = await untilAbort(runtime.read(turn.callId), signal);
    if (!state) return err({ kind: "effectFailure" });
    if (!state.ok) return state;
    const [current, stop] = await Promise.all([untilAbort(this.policies.read(scope), signal), untilAbort(this.ledger.readWriteStop(scope), signal)]);
    const live = await untilAbort(runtime.read(turn.callId), signal);
    if (!live) return err({ kind: "effectFailure" });
    if (!live.ok) return live;
    const valid = (value: CallState["policy"]) => value.automationEnabled === true && value.bookingEnabled === true &&
      value.capabilities.book === "execute" && value.staffWorkEnabled === true;
    if (signal.aborted || !Number.isFinite(Date.parse(now)) || !this.enabled() || !current?.ok || !stop?.ok || stop.value.stopped || !valid(current.value) || !valid(live.value.policy) ||
        current.value.policyVersion !== live.value.policy.policyVersion || live.value.lifecycle !== "active" ||
        !live.value.sessionLease || live.value.sessionLease.sessionId !== turn.sessionId || Date.parse(live.value.sessionLease.expiresAt) <= Date.parse(now) ||
        live.value.conversationRevision !== state.value.conversationRevision) return err({ kind: "invalidTransition" });
    return live;
  }
  async run(scope: LocationScope, turn: FinalCallerTurn, now: string, incomingOperation: Readonly<{ from: string; to: string; window?: import("../core/booking-search-window.ts").BookingSearchWindow | null; preference?: import("../core/booking-search-preference.ts").BookingSearchPreference }> | Readonly<{ choice: 1|2|3 }>, external?: AbortSignal):
    Promise<Result<CallState, Failure>> {
    const operation = Object.freeze({ ...incomingOperation, ...("window" in incomingOperation && validBookingSearchWindow(incomingOperation.window)
      ? { window: copyBookingSearchWindow(incomingOperation.window) } : {}) });
    const runtime = new CallRuntime(this.ledger, scope);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), bookingMenuDeadlineMs), signal = AbortSignal.any([controller.signal, ...(external ? [external] : [])]);
    try {
      const initial = await this.#ready(scope, turn, now, signal);
      if (!initial.ok) return external?.aborted ? err({ kind: "staleTurn" }) : initial;
      if (initial.value.processedTurnIds.includes(turn.turnId)) return initial;
      const revision = initial.value.conversationRevision;
      let interpretation: TurnInterpretation = { kind: "bookingMenuFailure" };
      if (turn.quality === "clear" && !initial.value.pendingPresentationId) {
        const query = Object.freeze({ scope: Object.freeze({ ...scope }), callId: turn.callId, sessionId: turn.sessionId!, turnId: turn.turnId,
          policyVersion: initial.value.policy.policyVersion, now, signal });
        if ("from" in operation) {
          const read = await untilAbort(this.host.readBookingMenu!({ ...query, ...operation }), signal);
          const expectedWindow = operation.window;
          const matchesWindow = expectedWindow === undefined || expectedWindow === null ?
            expectedWindow === undefined || read?.ok && read.value.window === undefined :
            read?.ok && sameBookingSearchWindow(expectedWindow, read.value.window);
          const preference = operation.preference;
          const matchesPreference = !preference || read?.ok && (!preference.practitioner ? true : preference.practitioner === "any" ? read.value.searchScope?.selection === "earliestApproved" :
            normalizedSpokenName(read.value.practitionerName) === normalizedSpokenName(preference.practitioner)) &&
            (!preference.location || normalizedSpokenName(read.value.locationName) === normalizedSpokenName(preference.location));
          if (read?.ok && matchesPreference && matchesWindow && !signal.aborted) interpretation = { kind: "bookingMenu", snapshot: structuredClone(read.value) };
          else if (read && !read.ok && read.error.kind === "outsideHorizon" && !signal.aborted) interpretation = { kind: "bookingHorizon", snapshot: structuredClone(read.error.snapshot) };
        } else {
          const menuTurnId = initial.value.processedTurnIds.at(-1);
          const notice = menuTurnId ? initial.value.presentations[noticePresentationId(turn.callId, menuTurnId)] : undefined;
          if (menuTurnId && notice?.status === "played" && notice.kind === "notice") {
            const selected = await untilAbort(this.host.selectBookingMenu!({ ...query, menuTurnId, choice: operation.choice }), signal);
            if (selected?.ok && !signal.aborted) {
              const evidence = await untilAbort(this.host.resolveBooking(scope, selected.value.verificationRef, selected.value.offerRef, now, signal), signal);
              if (evidence?.ok && !signal.aborted) interpretation = { kind: "requestAction", request: structuredClone(evidence.value) };
            }
          }
        }
      }
      const acceptedAt = interpretation.kind === "bookingHorizon" ? (this.clock?.() ?? now) : now;
      const fresh = await this.#ready(scope, turn, acceptedAt, signal);
      if (!fresh.ok) return external?.aborted ? err({ kind: "staleTurn" }) : fresh;
      if (signal.aborted) return err({ kind: "effectFailure" });
      return runtime.acceptTurn(turn, interpretation, acceptedAt, revision);
    } catch { return err({ kind: external?.aborted ? "staleTurn" : "effectFailure" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
