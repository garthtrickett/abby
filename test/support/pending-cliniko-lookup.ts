import { bookingCallFlowFixture, reschedulingCallFlowFixture } from "./cliniko-call-flow.ts";

/** A signed-call fixture may hold one real adapter availability response. The
 * provider deliberately ignores cancellation so its late result is observable. */
export async function pendingClinikoLookupFixture(options: { workflow?: "book" | "reschedule"; hold?: "availableTimes" | "appointmentList" | "appointmentTarget" } = {}) {
  const f = options.workflow === "reschedule" ? await reschedulingCallFlowFixture() : await bookingCallFlowFixture();
  let armed = false, held = false, released = false, reads = 0, signal: AbortSignal | null | undefined;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const provider = f.flowConfig.fetchPort!;
  const fetchPort: typeof fetch = async (value, init) => {
    const response = await provider(value, init);
    const path = new URL(String(value)).pathname;
    const matches = options.hold === "appointmentList" ? path === "/v1/individual_appointments" :
      options.hold === "appointmentTarget" ? path === "/v1/individual_appointments/91" : path.endsWith("/available_times");
    if (matches) {
      reads++;
      if (armed && !held) { held = true; signal = init?.signal; entered(); await wait; released = true; }
    }
    return response;
  };
  return { ...f, flowConfig: { ...f.flowConfig, fetchPort }, started, arm: () => { armed = true; }, release,
    get held() { return held && !released; }, get canceled() { return signal?.aborted === true; }, get reads() { return reads; } };
}
