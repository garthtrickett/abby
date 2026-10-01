/** A failed or stalled dependency check must not hold an HTTP health response open. */
export function boundedHealthCheck(probe: () => Promise<unknown>, timeoutMs = 1_500): () => Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("invalid health timeout");
  let inFlight: Promise<boolean> | undefined;
  return () => {
    if (!inFlight) {
      const task = Promise.resolve().then(probe).then(() => true, () => false);
      inFlight = task;
      void task.finally(() => { if (inFlight === task) inFlight = undefined; });
    }
    const current = inFlight;
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void current.then(value => { clearTimeout(timer); resolve(value); });
    });
  };
}
