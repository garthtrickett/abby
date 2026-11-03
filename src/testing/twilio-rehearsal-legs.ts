import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import type { RehearsalObservedCall } from "./twilio-rehearsal-observation.ts";

const sid = /^CA[0-9a-f]{32}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function observedCall(value: unknown): RehearsalObservedCall {
  if (!record(value) || typeof value.sid !== "string" || !sid.test(value.sid) ||
      typeof value.account_sid !== "string" || !/^AC[0-9a-f]{32}$/.test(value.account_sid) ||
      typeof value.from !== "string" || typeof value.to !== "string" ||
      typeof value.direction !== "string" || typeof value.status !== "string" ||
      !(value.parent_call_sid === null || typeof value.parent_call_sid === "string" && sid.test(value.parent_call_sid)) ||
      !(value.start_time === null || typeof value.start_time === "string" && Number.isFinite(Date.parse(value.start_time))))
    throw Error("Carrier leg observation unavailable");
  return { sid: value.sid, accountSid: value.account_sid, from: value.from, to: value.to,
    direction: value.direction, status: value.status, parentCallSid: value.parent_call_sid,
    startTime: value.start_time === null ? null : new Date(value.start_time) };
}

/** GET-only, exact-leg observations. A bounded first page with an absent or
 * non-null continuation never proves that all children have been observed. */
export function rehearsalLegObserver(accountSid: string, authToken: string, fetcher: typeof fetch = fetch) {
  if (!/^AC[0-9a-f]{32}$/.test(accountSid) || !authToken) throw Error("Invalid carrier observation configuration");
  const base = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
  const authorization = "Basic " + Buffer.from(accountSid + ":" + authToken).toString("base64");
  async function get(path: string): Promise<unknown> {
    const signal = AbortSignal.timeout(8_000);
    try {
      const response = await fetcher(base + path, { method: "GET", headers: { authorization }, signal, redirect: "error" });
      if (!response.ok) throw Error("Unavailable");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await ownedBodyBytes(response.body, 128_000, signal)));
    } catch { throw Error("Carrier leg observation unavailable"); }
  }
  return {
    async target(callSid: string): Promise<RehearsalObservedCall> {
      if (!sid.test(callSid)) throw Error("Invalid carrier leg identity");
      const result = observedCall(await get(`/Calls/${callSid}.json`));
      if (result.sid !== callSid || result.accountSid !== accountSid) throw Error("Carrier leg identity unavailable");
      return result;
    },
    async children(parent: string): Promise<Readonly<{ complete: boolean; calls: readonly RehearsalObservedCall[] }>> {
      if (!sid.test(parent)) throw Error("Invalid carrier leg identity");
      const raw = await get("/Calls.json?" + new URLSearchParams({ ParentCallSid: parent, PageSize: "20" }));
      if (!record(raw) || !Array.isArray(raw.calls) || raw.calls.length > 20) throw Error("Carrier child observation unavailable");
      const calls = raw.calls.map(observedCall);
      if (calls.some(call => call.parentCallSid !== parent || call.accountSid !== accountSid))
        throw Error("Carrier child identity unavailable");
      return { complete: raw.next_page_uri === null, calls };
    },
  };
}
