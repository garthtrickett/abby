import type { AppointmentChangeEvidenceHost, ReschedulingMenuHost, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err } from "../core/model.ts";
import type { CallState, FinalCallerTurn, LocationScope, Result, TransitionFailure, TurnInterpretation } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import { noticePresentationId } from "../core/transition.ts";

type Host = Partial<AppointmentChangeEvidenceHost & ReschedulingMenuHost>;
type Failure = TransitionFailure | Readonly<{ kind: "effectFailure" }>;
async function untilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  let stop: () => void = () => undefined;
  const stopped = new Promise<undefined>(resolve => { stop = () => resolve(undefined); signal.addEventListener("abort", stop); if (signal.aborted) stop(); });
  try { return await Promise.race([pending, stopped]); } finally { signal.removeEventListener("abort", stop); }
}

/** Both agent commands use real SAM turns/presentation receipts, with private host selection state. */
export class ReschedulingMenuTurns {
  private readonly ledger: LedgerStore; private readonly policies: PolicyStore; private readonly host: Host;
  constructor(ledger: LedgerStore, policies: PolicyStore, host: Host) { this.ledger = ledger; this.policies = policies; this.host = host; }
  enabled(): boolean { return !!this.host.resolveAppointmentChange && this.host.reschedulingMenuAvailable?.() === true && !!this.host.readReschedulingMenu && !!this.host.selectReschedulingMenu; }
  async #ready(scope: LocationScope, turn: FinalCallerTurn, now: string, signal: AbortSignal): Promise<Result<CallState, Failure>> {
    const runtime = new CallRuntime(this.ledger, scope), state = await untilAbort(runtime.read(turn.callId), signal);
    if (!state) return err({ kind: "effectFailure" });
    if (!state.ok) return state;
    const [current, stop] = await Promise.all([untilAbort(this.policies.read(scope), signal), untilAbort(this.ledger.readWriteStop(scope), signal)]);
    const live = await untilAbort(runtime.read(turn.callId), signal);
    if (!live) return err({ kind: "effectFailure" });
    if (!live.ok) return live;
    const valid = (value: CallState["policy"]) => value.automationEnabled === true && value.reschedulingEnabled === true &&
      value.capabilities.reschedule === "execute" && value.staffWorkEnabled === true;
    if (signal.aborted || !Number.isFinite(Date.parse(now)) || !this.enabled() || !current?.ok || !stop?.ok || stop.value.stopped || !valid(current.value) || !valid(live.value.policy) ||
        current.value.policyVersion !== live.value.policy.policyVersion || live.value.lifecycle !== "active" ||
        !live.value.sessionLease || live.value.sessionLease.sessionId !== turn.sessionId || Date.parse(live.value.sessionLease.expiresAt) <= Date.parse(now) ||
        live.value.conversationRevision !== state.value.conversationRevision) return err({ kind: "invalidTransition" });
    return live;
  }
  async run(incomingScope: LocationScope, incomingTurn: FinalCallerTurn, now: string, stage: "targets" | "offers", incomingOperation: Readonly<{ from: string; to: string }> | Readonly<{ choice: 1|2|3 }>):
    Promise<Result<CallState, Failure>> {
    const scope = Object.freeze({ ...incomingScope }), turn = Object.freeze(structuredClone(incomingTurn)), operation = Object.freeze({ ...incomingOperation });
    const runtime = new CallRuntime(this.ledger, scope);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000), signal = controller.signal;
    try {
      const initial = await this.#ready(scope, turn, now, signal);
      if (!initial.ok) return initial;
      if (initial.value.processedTurnIds.includes(turn.turnId)) return initial;
      const revision = initial.value.conversationRevision;
      let interpretation: TurnInterpretation = { kind: "reschedulingMenuFailure" };
      if (turn.quality === "clear" && !initial.value.pendingPresentationId) {
        const query = Object.freeze({ scope: Object.freeze({ ...scope }), callId: turn.callId, sessionId: turn.sessionId!, turnId: turn.turnId,
          policyVersion: initial.value.policy.policyVersion, now, signal, stage });
        if ("from" in operation) {
          const priorTurnId = initial.value.processedTurnIds.at(-1);
          const prior = priorTurnId ? initial.value.presentations[noticePresentationId(turn.callId, priorTurnId)] : undefined;
          const read = stage === "offers" && prior?.status !== "played" ? undefined :
            await untilAbort(this.host.readReschedulingMenu!({ ...query, ...operation, ...(priorTurnId ? { priorTurnId } : {}) }), signal);
          if (read?.ok && !signal.aborted) interpretation = { kind: "reschedulingMenu", snapshot: structuredClone(read.value) };
        } else {
          const menuTurnId = initial.value.processedTurnIds.at(-1);
          const notice = menuTurnId ? initial.value.presentations[noticePresentationId(turn.callId, menuTurnId)] : undefined;
          if (menuTurnId && notice?.status === "played" && notice.kind === "notice") {
            const selected = await untilAbort(this.host.selectReschedulingMenu!({ ...query, menuTurnId, choice: operation.choice }), signal);
            if (selected?.ok && !signal.aborted) {
              if (selected.value.kind === "targetSelected") interpretation = { kind: "reschedulingMenu", snapshot: structuredClone(selected.value.snapshot) };
              else {
                const evidence = await untilAbort(this.host.resolveAppointmentChange!({ scope, callId: turn.callId, sessionId: turn.sessionId!,
                  policyVersion: query.policyVersion, now, kind: "reschedule", verificationRef: selected.value.verificationRef,
                  targetRef: selected.value.targetRef, offerRef: selected.value.offerRef }, signal), signal);
                if (evidence?.ok && evidence.value.kind === "reschedule" && !signal.aborted) interpretation = { kind: "requestAction", request: structuredClone(evidence.value) };
              }
            }
          }
        }
      }
      const fresh = await this.#ready(scope, turn, now, signal);
      if (!fresh.ok) return fresh;
      if (signal.aborted) return err({ kind: "effectFailure" });
      return runtime.acceptTurn(turn, interpretation, now, revision);
    } catch { return err({ kind: "effectFailure" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
