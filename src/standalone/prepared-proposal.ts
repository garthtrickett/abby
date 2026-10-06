import { digestActionRequest } from "../core/digest.ts";
import type { ActionRequest, CallState } from "../core/model.ts";

/** A canceled preparation may be replaced. A dispatched, committed or unknown
 * action must retain its send fence. An unbound late preparation is discarded
 * only when the caller's conversation has advanced since it was captured. */
export function preparationMayBeDiscarded(state: CallState, request: ActionRequest, capturedRevision: number): boolean {
  const digest = digestActionRequest(request);
  const bound = Object.values(state.actions).filter(action => action.digest === digest);
  return bound.length ? bound.every(action => action.status === "canceled") : state.conversationRevision !== capturedRevision;
}
