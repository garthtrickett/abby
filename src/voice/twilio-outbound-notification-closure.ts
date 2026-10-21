import { createHash } from "node:crypto";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { readTwilioSingleRoot } from "./internal/twilio-single-root-read.ts";
import type { OutboundProviderBinding } from "./outbound-runtime.ts";

export type TwilioNotificationClosureInput = Readonly<{ callSid: string; number: string; attemptedAt: string; notifiedAt: string; evidenceDigest: string }>;
export type TwilioNotificationClosureQuery = Readonly<{
  purpose: "providerTerminalFromCompletedNotification";
  operation: "approveExclusiveSingleRootProfile" | "readRootCall" | "readChildCalls";
  provider: OutboundProviderBinding; inspectionBinding: string; accountSid: string; from: string; input: TwilioNotificationClosureInput;
  /** Approval covers every creator/updater, fallback/TwiML/transfer path and
   * restore source for this original identity, not merely Abby's local code. */
  coverage: "allCallCreationMutationAndRestoreSources";
}>;
export type TwilioNotificationClosureAuthority = Readonly<{
  allows(query: TwilioNotificationClosureQuery, signal: AbortSignal): Promise<boolean>;
  current(query: TwilioNotificationClosureQuery, signal: AbortSignal): boolean;
}>;
export type TwilioNotificationClosureResult = Readonly<{ kind: "unknown" | "active" }> | Readonly<{
  kind: "singleRootClosed"; callSid: string; endedAt: string; observedAt: string; digest: string;
}>;
type Config = Readonly<{ provider: OutboundProviderBinding; accountSid: string; authToken: string; from: string; deadlineMs: number; now: () => string }>;
const instant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Independently approved completed-call evidence after a native authenticated
 * notification. notifiedAt is NOT endedAt or a speech stop. Missing native end
 * times, any child, incomplete pages or withdrawn all-source/restore approval
 * keep closure unknown. This supplies neither contact truth nor a release. */
export class TwilioOutboundNotificationClosure {
  readonly #config: Config;
  readonly #fetch: typeof fetch;
  readonly #binding: string;
  constructor(c: Config, port: typeof fetch) {
    if (!/^AC[0-9a-f]{32}$/.test(c.accountSid) || !c.authToken || c.authToken.length > 256 || !/^\+[1-9][0-9]{7,14}$/.test(c.from) ||
        !Number.isSafeInteger(c.deadlineMs) || c.deadlineMs < 1 || c.deadlineMs > 30000 || typeof c.now !== "function" || typeof port !== "function") throw Error("Invalid call inspection");
    this.#config = Object.freeze({ ...c, provider: Object.freeze({ ...c.provider }), now: c.now.bind(c) }); this.#fetch = port;
    this.#binding = hash(["abby.twilio.notification-root-closure.v1", c.provider, c.accountSid, hash(c.authToken), c.from, c.deadlineMs]);
  }
  binding(): string { return this.#binding; }
  accountSid(): string { return this.#config.accountSid; }
  async inspect(input: TwilioNotificationClosureInput, authority: TwilioNotificationClosureAuthority, external: AbortSignal): Promise<TwilioNotificationClosureResult> {
    if (!(external instanceof AbortSignal) || external.aborted) return { kind: "unknown" };
    const c = this.#config, controller = new AbortController(), timer = setTimeout(() => controller.abort(), c.deadlineMs);
    const signal = AbortSignal.any([external, controller.signal]), began = performance.now(); let last = "";
    try {
      if (!input || Object.keys(input).sort().join(",") !== "attemptedAt,callSid,evidenceDigest,notifiedAt,number" || !/^CA[0-9a-f]{32}$/.test(input.callSid) ||
          !/^\+[1-9][0-9]{7,14}$/.test(input.number) || !instant(input.attemptedAt) || !instant(input.notifiedAt) || input.notifiedAt < input.attemptedAt ||
          !/^[a-f0-9]{64}$/.test(input.evidenceDigest) || typeof authority?.allows !== "function" || typeof authority.current !== "function") return { kind: "unknown" };
      const captured = Object.freeze({ ...input }), allows = authority.allows.bind(authority), live = authority.current.bind(authority);
      const queries = new Map<TwilioNotificationClosureQuery["operation"], TwilioNotificationClosureQuery>();
      const now = () => { const at = c.now(); if (signal.aborted || performance.now() - began > c.deadlineMs || !instant(at) || at < last) throw Error("Unavailable clock"); last = at; return at; };
      const current = () => { now(); if ([...queries.values()].some(q => live(q, signal) !== true)) throw Error("Read permission unavailable"); now(); };
      const wait = async <T>(task: Promise<T>) => { const v = await awaitUntilAbort(task, signal); if (v === undefined) throw Error("Unavailable call read"); current(); return v; };
      const permit = async (operation: TwilioNotificationClosureQuery["operation"]) => {
        current(); const q = Object.freeze({ purpose: "providerTerminalFromCompletedNotification" as const, operation, provider: c.provider, inspectionBinding: this.#binding, accountSid: c.accountSid, from: c.from,
          input: captured, coverage: "allCallCreationMutationAndRestoreSources" as const });
        if (live(q, signal) !== true || await wait(Promise.resolve().then(() => allows(q, signal))) !== true || live(q, signal) !== true) throw Error("Read permission unavailable");
        queries.set(operation, q); current();
      };
      const found = await readTwilioSingleRoot(c, captured, { kind: "completedNotification", at: captured.notifiedAt }, { signal, now, current, permit, wait }, this.#fetch);
      if (found.kind !== "singleRootClosed") return found;
      const first = found.snapshot;
      return Object.freeze({ kind: "singleRootClosed", callSid: captured.callSid, endedAt: first.endedAt, observedAt: found.observedAt,
        digest: hash(["abby.twilio.notification-root-evidence.v1", this.#binding, captured, { callSid: first.callSid, createdAt: first.createdAt, startAt: first.startAt, endedAt: first.endedAt }, "twoCompleteEmptyChildPages"]) });
    } catch { return { kind: "unknown" }; } finally { clearTimeout(timer); controller.abort(); }
  }
}
