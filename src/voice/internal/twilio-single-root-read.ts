import { isDeepStrictEqual } from "node:util";
import { ownedBodyBytes } from "../../shared/owned-body-bytes.ts";

type Connection = Readonly<{ accountSid: string; authToken: string; from: string }>;
type Original = Readonly<{ callSid: string; number: string; attemptedAt: string }>;
export type TwilioClosureReadOperation = "approveExclusiveSingleRootProfile" | "readRootCall" | "readChildCalls";
type Evidence = Readonly<{ kind: "positiveStop" | "completedNotification"; at: string }>;
type ReadControl = Readonly<{ signal: AbortSignal; now(): string; current(): void;
  permit(operation: TwilioClosureReadOperation): Promise<void>; wait<T>(task: Promise<T>): Promise<T> }>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function providerTime(v: unknown): string | undefined {
  if (typeof v !== "string" || !/^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} (?:\+0000|GMT)$/.test(v)) return;
  const n = Date.parse(v); if (!Number.isFinite(n)) return;
  const d = new Date(n); return d.toUTCString() === v.replace(/\+0000$/, "GMT") ? d.toISOString() : undefined;
}
function samePage(value: unknown, expected: string): boolean {
  try {
    if (typeof value !== "string" || !value.startsWith("/")) return false;
    const actual = new URL(value, "https://api.twilio.com"), target = new URL(expected, "https://api.twilio.com");
    return actual.origin === target.origin && !actual.hash && actual.pathname === target.pathname &&
      [...actual.searchParams].length === 3 && [...target.searchParams].every(([key, v]) => actual.searchParams.getAll(key).length === 1 && actual.searchParams.get(key) === v);
  } catch { return false; }
}
function discard(r: Response | undefined): void { try { void r?.body?.cancel().catch(() => {}); } catch { /* Own response. */ } }

/** Private common read owner. Both public interfaces keep distinct evidence
 * contracts and permission-query shapes. A completed notification is only an
 * upper bound on provider end; it never becomes a fabricated speech stop or end
 * timestamp. Actual canonical provider times, two identical roots, two complete
 * empty child pages and fresh independent source approval remain mandatory. */
export async function readTwilioSingleRoot(c: Connection, captured: Original, event: Evidence, control: ReadControl, port: typeof fetch) {
  const { signal, now, current, permit, wait } = control;
  const path = `/2010-04-01/Accounts/${c.accountSid}/Calls`, root = `${path}/${captured.callSid}.json`;
  const children = path + ".json?" + new URLSearchParams({ ParentCallSid: captured.callSid, PageSize: "100", Page: "0" });
  const get = async (relative: string, operation: "readRootCall" | "readChildCalls") => {
    await permit("approveExclusiveSingleRootProfile"); await permit(operation); let response: Response | undefined, owned = false;
    try {
      current(); const url = `https://api.twilio.com${relative}`;
      const found = await wait(port(url, { method: "GET", redirect: "error", signal,
        headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64")}` } }).then(r => { response = r; if (signal.aborted) discard(r); return r; }));
      if (found.status !== 200 || found.redirected || found.url && found.url !== url || found.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw Error("Unavailable provider body");
      owned = true; const bytes = await wait(ownedBodyBytes(found.body, 131072, signal)); const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      await permit("approveExclusiveSingleRootProfile"); await permit(operation); return raw;
    } finally { if (!owned) discard(response); }
  };
  const readRoot = async () => {
    const v = await get(root, "readRootCall");
    if (!object(v) || v.account_sid !== c.accountSid || v.sid !== captured.callSid || v.from !== c.from || v.to !== captured.number ||
        v.parent_call_sid !== null || v.direction !== "outbound-api" || v.uri !== root) throw Error("Unmatched root");
    if (["queued", "initiated", "ringing", "in-progress"].includes(String(v.status))) return undefined;
    // Unsupported terminal statuses lack this contract’s completed-call end
    // evidence. A notification alone cannot establish their closure.
    const createdAt = providerTime(v.date_created), startAt = providerTime(v.start_time), endedAt = providerTime(v.end_time), updatedAt = providerTime(v.date_updated);
    if (v.status !== "completed" || !createdAt || !startAt || !endedAt || !updatedAt) throw Error("Unmatched completed call");
    const matchesEvent = event.kind === "positiveStop" ? startAt <= event.at && event.at <= endedAt : endedAt <= event.at && event.at <= now();
    if (Date.parse(createdAt) < Math.floor(Date.parse(captured.attemptedAt) / 1000) * 1000 || createdAt > startAt ||
        startAt > endedAt || endedAt < captured.attemptedAt || !matchesEvent || endedAt > updatedAt || updatedAt > now())
      throw Error("Unmatched completed call");
    return Object.freeze({ callSid: captured.callSid, createdAt, startAt, endedAt, updatedAt });
  };
  const noChildren = async () => {
    const v = await get(children, "readChildCalls");
    if (!object(v) || !Array.isArray(v.calls) || v.calls.length !== 0 || v.next_page_uri !== null || v.previous_page_uri !== null ||
        v.page !== 0 || v.page_size !== 100 || !samePage(v.uri, children) || !samePage(v.first_page_uri, children)) throw Error("Incomplete single-root history");
  };
  now(); const first = await readRoot(); if (!first) return { kind: "active" as const };
  await noChildren(); const again = await readRoot(); if (!again || !isDeepStrictEqual(again, first)) return { kind: "unknown" as const };
  await noChildren(); await permit("approveExclusiveSingleRootProfile"); current();
  return Object.freeze({ kind: "singleRootClosed" as const, snapshot: first, observedAt: now() });
}
