import { setTimeout as delay } from "node:timers/promises";
import { qualifyRehearsalObservation } from "./twilio-rehearsal-observation.ts";
import type { rehearsalLegObserver } from "./twilio-rehearsal-legs.ts";

type Config = Parameters<typeof qualifyRehearsalObservation>[0];
type Evidence = Omit<Parameters<typeof qualifyRehearsalObservation>[1], "now" | "target" | "children">;
type Observation = Readonly<{ targetCallSid: string; targetStatus: string;
  childrenComplete: boolean; children: readonly Readonly<{ sid: string; status: string }>[] }>;

/** Read-only final qualification. Cancellation invalidates an otherwise matching
 * observation, including cancellation while a provider read is in flight. */
export async function observeRehearsalCarrier(config: Config, evidence: Evidence,
  observer: ReturnType<typeof rehearsalLegObserver>, options: Readonly<{
    signal: AbortSignal; now?: () => number; wait?: () => Promise<void>;
  }>) {
  const now = options.now ?? Date.now, wait = options.wait ?? (() => delay(1_000));
  const checkCanceled = () => {
    if (options.signal.aborted) throw Error("Carrier observation canceled");
  };
  checkCanceled();
  const targetSid = evidence.after.latest?.callSid;
  if (!targetSid) throw Error("Exact target identity unavailable");
  let result: ReturnType<typeof qualifyRehearsalObservation> | undefined;
  let observation: Observation | undefined;
  const deadline = now() + 20_000;
  for (let index = 0; index < 15 && now() < deadline; index++) {
    checkCanceled();
    try {
      const target = await observer.target(targetSid);
      checkCanceled();
      const children = await observer.children(targetSid);
      checkCanceled();
      observation = { targetCallSid: target.sid, targetStatus: target.status,
        childrenComplete: children.complete,
        children: children.calls.map(child => ({ sid: child.sid, status: child.status })) };
      result = qualifyRehearsalObservation(config, { ...evidence, now: now(), target, children });
      if (result.carrierScenarioPassed) break;
    } catch { /* A failed read cannot qualify a call; cancellation is checked below. */ }
    checkCanceled();
    if (index < 14 && now() < deadline) await wait();
  }
  checkCanceled();
  if (!result || !observation) throw Error("Complete carrier observation unavailable");
  return { result, observation };
}
