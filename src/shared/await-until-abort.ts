/** Bound a consumer's wait even when an injected dependency ignores its signal. */
export async function awaitUntilAbort<Value>(pending: Promise<Value>, signal?: AbortSignal): Promise<Value | undefined> {
  if (!signal) return pending;
  if (signal.aborted) { void pending.catch(() => undefined); return undefined; }
  let onAbort = () => {};
  const aborted = new Promise<undefined>(resolve => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
