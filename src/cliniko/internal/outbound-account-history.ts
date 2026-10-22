import { ownedBodyBytes } from "../../shared/owned-body-bytes.ts";
import { claimClinikoBudget, observeCliniko429 } from "../read-budget.ts";
import type { ClinikoRequestBudget } from "../read-budget.ts";
import type { NativeOutboundFailure } from "./outbound-native-record.ts";
import { readAccountRecallHistory, readPatientRecallFamilies } from "./patient-recall-history.ts";

type Selection = Readonly<{ base: string; typeIds: readonly string[]; apiKey: string; contactEmail: string; rateBudget: ClinikoRequestBudget }>;
type ReadControl = Readonly<{
  signal: AbortSignal; now(): string; current(): void; permit(): Promise<void>;
  /** The caller's single whole-purpose deadline/monotonic clock also governs
   * protected record reads, so this loader cannot restart the operation budget. */
  wait<T>(task: Promise<T>): Promise<T>;
}>;
export class NativeOutboundHistoryReadError extends Error {
  readonly kind: NativeOutboundFailure["kind"];
  constructor(kind: NativeOutboundFailure["kind"]) { super("Native account history unavailable"); this.kind = kind; }
}
function discard(r: Response | undefined): void { try { void r?.body?.cancel().catch(() => {}); } catch { /* Own response only. */ } }

/** Private account-history read owner shared by the two actual MAC record
 * families. Callers cannot select arbitrary native URLs: the existing bounded
 * all-page decoder owns the endpoint and archived/closed collection shape.
 * Family-specific producer/key/source/read grants and original correlation stay
 * with the caller; no transport result attests call/contact completeness. */
async function readNativeOutboundHistory(selection: Selection, control: ReadControl, port: typeof fetch, patientId?: string) {
  const { signal, current, permit, wait } = control, budget = selection.rateBudget;
  const get = async (url: string): Promise<unknown> => {
    await permit(); const limited = await wait(claimClinikoBudget(budget));
    if (limited) throw new NativeOutboundHistoryReadError(limited.kind);
    await permit(); let response: Response | undefined, owned = false;
    try {
      current();
      const found = await wait(port(url, { method: "GET", redirect: "error", signal, headers: { Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${selection.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${selection.contactEmail})` } })
        .then(v => { response = v; if (signal.aborted) discard(v); return v; }));
      if (found.redirected || found.url && found.url !== url) throw new NativeOutboundHistoryReadError("mismatched");
      if (found.status === 429) { await wait(observeCliniko429(budget, found.headers.get("X-RateLimit-Reset"))); throw new NativeOutboundHistoryReadError("rateLimited"); }
      if (found.status === 401 || found.status === 403) throw new NativeOutboundHistoryReadError("forbidden");
      if (found.status !== 200) throw new NativeOutboundHistoryReadError("unavailable");
      owned = true; const bytes = await wait(ownedBodyBytes(found.body, 1000000, signal)); let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new NativeOutboundHistoryReadError("malformed"); }
      await permit(); return raw;
    } finally { if (!owned) discard(response); }
  };
  return patientId === undefined
    ? readAccountRecallHistory({ base: selection.base, typeIds: selection.typeIds }, get, control.now)
    : readPatientRecallFamilies({ base: selection.base, patientId, typeIds: selection.typeIds }, get, control.now);
}

/** Preserve the full account-body scope for existing account-history owners. */
export function readNativeOutboundAccountHistory(selection: Selection, control: ReadControl, port: typeof fetch) {
  return readNativeOutboundHistory(selection, control, port);
}
/** Patient selection comes from the independently authenticated original call;
 * the caller still owns explicit whole-patient history grants and all bounds. */
export function readNativeOutboundPatientHistory(selection: Selection & Readonly<{ patientId: string }>, control: ReadControl, port: typeof fetch) {
  return readNativeOutboundHistory(selection, control, port, selection.patientId);
}
