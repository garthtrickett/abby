import { AsyncLocalStorage } from "node:async_hooks";
import type { ClinikoReservedRun } from "./read-budget.ts";
import { reservationLifetimeMs } from "./request-budget-state.ts";

type Context = { readonly id: string; readonly signal: AbortSignal; active: boolean };
const contexts = new AsyncLocalStorage<ReadonlyMap<object | string, Context>>();
export function budgetReservationContext(key: object | string): Readonly<{ id: string; valid: boolean }> | undefined {
  const c = contexts.getStore()?.get(key);
  return c ? { id: c.id, valid: c.active && !c.signal.aborted } : undefined;
}

/** Allocation context carries no clinical authority. Closing it fences queued
 * async descendants even when storage release fails and capacity expires later. */
export async function runBudgetReservation<T>(key: object | string, id: string, signal: AbortSignal, task: () => Promise<T>, release: () => Promise<void>): Promise<ClinikoReservedRun<T>> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(reservationLifetimeMs)]);
  const c: Context = { id, signal, active: true }, scope = new Map(contexts.getStore()); scope.set(key, c);
  const interrupted = Symbol("interrupted");
  let onAbort = () => {};
  const abort = new Promise<typeof interrupted>(resolve => { onAbort = () => { c.active = false; resolve(interrupted); }; signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort(); });
  try {
    if (signal.aborted) return { kind: "denied", denial: { kind: "unavailable" } };
    const work = contexts.run(scope, async () => signal.aborted ? interrupted : task());
    const result = await Promise.race([work, abort]);
    return result === interrupted || signal.aborted ? { kind: "interrupted" } : { kind: "completed", value: result as T };
  } catch { return { kind: "interrupted" }; }
  finally {
    c.active = false; signal.removeEventListener("abort", onAbort);
    try { await release(); } catch { /* Remaining capacity stays held until expiry. */ }
  }
}
