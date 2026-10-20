import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import type { OutboundProviderBinding } from "./outbound-runtime.ts";

export type TwilioCallClosureInput = Readonly<{ callSid: string; number: string; attemptedAt: string; stoppedAt: string; evidenceDigest: string }>;
export type TwilioCallClosureQuery = Readonly<{
  operation: "approveExclusiveSingleRootProfile" | "readRootCall" | "readChildCalls";
  provider: OutboundProviderBinding; inspectionBinding: string; accountSid: string; from: string; input: TwilioCallClosureInput;
  /** Approval covers every creator/updater, fallback/TwiML/transfer path and
   * restore source for this original identity, not merely Abby's local code. */
  coverage: "allCallCreationMutationAndRestoreSources";
}>;
export type TwilioCallClosureAuthority = Readonly<{
  allows(query: TwilioCallClosureQuery, signal: AbortSignal): Promise<boolean>;
  current(query: TwilioCallClosureQuery, signal: AbortSignal): boolean;
}>;
export type TwilioCallClosureResult = Readonly<{ kind: "unknown" | "active" }> | Readonly<{
  kind: "singleRootClosed"; callSid: string; endedAt: string; observedAt: string; digest: string;
}>;
type Config = Readonly<{ provider: OutboundProviderBinding; accountSid: string; authToken: string; from: string; deadlineMs: number; now: () => string }>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const instant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
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

/** Read-only provider evidence for the fixed Connect/Stream/Hangup profile.
 * No callback/root-only completion inference: independently admitted complete
 * single-root coverage, two exact root reads and two empty complete child
 * pages are mandatory. ANY child/pagination is unsupported and keeps holds.
 * This reader does not create, update, delete, classify speech or release. */
export class TwilioOutboundCallClosure {
  readonly #config: Config;
  readonly #fetch: typeof fetch;
  readonly #binding: string;
  constructor(c: Config, port: typeof fetch) {
    if (!/^AC[0-9a-f]{32}$/.test(c.accountSid) || !c.authToken || c.authToken.length > 256 || !/^\+[1-9][0-9]{7,14}$/.test(c.from) ||
        !Number.isSafeInteger(c.deadlineMs) || c.deadlineMs < 1 || c.deadlineMs > 30000 || typeof c.now !== "function" || typeof port !== "function") throw Error("Invalid call inspection");
    this.#config = Object.freeze({ ...c, provider: Object.freeze({ ...c.provider }), now: c.now.bind(c) }); this.#fetch = port;
    this.#binding = hash(["abby.twilio.single-root-closure.v1", c.provider, c.accountSid, hash(c.authToken), c.from, c.deadlineMs]);
  }
  binding(): string { return this.#binding; }
  accountSid(): string { return this.#config.accountSid; }
  async inspect(input: TwilioCallClosureInput, authority: TwilioCallClosureAuthority, external: AbortSignal): Promise<TwilioCallClosureResult> {
    if (!(external instanceof AbortSignal) || external.aborted) return { kind: "unknown" };
    const c = this.#config, controller = new AbortController(), timer = setTimeout(() => controller.abort(), c.deadlineMs);
    const signal = AbortSignal.any([external, controller.signal]), began = performance.now(); let last = "";
    try {
      if (!input || Object.keys(input).sort().join(",") !== "attemptedAt,callSid,evidenceDigest,number,stoppedAt" || !/^CA[0-9a-f]{32}$/.test(input.callSid) ||
          !/^\+[1-9][0-9]{7,14}$/.test(input.number) || !instant(input.attemptedAt) || !instant(input.stoppedAt) || input.stoppedAt < input.attemptedAt ||
          !/^[a-f0-9]{64}$/.test(input.evidenceDigest) || typeof authority?.allows !== "function" || typeof authority.current !== "function") return { kind: "unknown" };
      const captured = Object.freeze({ ...input }), allows = authority.allows.bind(authority), live = authority.current.bind(authority);
      const queries = new Map<TwilioCallClosureQuery["operation"], TwilioCallClosureQuery>();
      const now = () => { const at = c.now(); if (signal.aborted || performance.now() - began > c.deadlineMs || !instant(at) || at < last) throw Error("Unavailable clock"); last = at; return at; };
      const current = () => { now(); if ([...queries.values()].some(q => live(q, signal) !== true)) throw Error("Read permission unavailable"); now(); };
      const wait = async <T>(task: Promise<T>) => { const v = await awaitUntilAbort(task, signal); if (v === undefined) throw Error("Unavailable call read"); current(); return v; };
      const permit = async (operation: TwilioCallClosureQuery["operation"]) => {
        current(); const q = Object.freeze({ operation, provider: c.provider, inspectionBinding: this.#binding, accountSid: c.accountSid, from: c.from,
          input: captured, coverage: "allCallCreationMutationAndRestoreSources" as const });
        if (live(q, signal) !== true || await wait(Promise.resolve().then(() => allows(q, signal))) !== true || live(q, signal) !== true) throw Error("Read permission unavailable");
        queries.set(operation, q); current();
      };
      const path = `/2010-04-01/Accounts/${c.accountSid}/Calls`, root = `${path}/${captured.callSid}.json`;
      const children = path + ".json?" + new URLSearchParams({ ParentCallSid: captured.callSid, PageSize: "100", Page: "0" });
      const get = async (relative: string, operation: "readRootCall" | "readChildCalls") => {
        await permit("approveExclusiveSingleRootProfile"); await permit(operation); let response: Response | undefined, owned = false;
        try {
          current(); const url = `https://api.twilio.com${relative}`;
          const found = await wait(this.#fetch(url, { method: "GET", redirect: "error", signal,
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
        // A signed answered-speech observation cannot coexist with busy/failed/
        // unanswered. Those statuses also lack a trustworthy completed end time.
        const createdAt = providerTime(v.date_created), startAt = providerTime(v.start_time), endedAt = providerTime(v.end_time), updatedAt = providerTime(v.date_updated);
        if (v.status !== "completed" || !createdAt || !startAt || !endedAt || !updatedAt ||
            Date.parse(createdAt) < Math.floor(Date.parse(captured.attemptedAt) / 1000) * 1000 || createdAt > startAt || startAt > captured.stoppedAt ||
            captured.stoppedAt > endedAt || endedAt > updatedAt || updatedAt > now()) throw Error("Unmatched completed call");
        return Object.freeze({ callSid: captured.callSid, createdAt, startAt, endedAt, updatedAt });
      };
      const noChildren = async () => {
        const v = await get(children, "readChildCalls");
        if (!object(v) || !Array.isArray(v.calls) || v.calls.length !== 0 || v.next_page_uri !== null || v.previous_page_uri !== null ||
            v.page !== 0 || v.page_size !== 100 || !samePage(v.uri, children) || !samePage(v.first_page_uri, children)) throw Error("Incomplete single-root history");
      };
      now(); const first = await readRoot(); if (!first) return { kind: "active" };
      await noChildren(); const again = await readRoot(); if (!again || !isDeepStrictEqual(again, first)) return { kind: "unknown" };
      await noChildren(); await permit("approveExclusiveSingleRootProfile"); current();
      return Object.freeze({ kind: "singleRootClosed", callSid: captured.callSid, endedAt: first.endedAt, observedAt: now(),
        digest: hash(["abby.twilio.single-root-evidence.v1", this.#binding, captured, { callSid: first.callSid, createdAt: first.createdAt, startAt: first.startAt, endedAt: first.endedAt }, "twoCompleteEmptyChildPages"]) });
    } catch { return { kind: "unknown" }; } finally { clearTimeout(timer); controller.abort(); }
  }
}
