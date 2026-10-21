import { createHash } from "node:crypto";
import { decodeAdministrativeMemo } from "../administrative-memo.ts";
import { administrativeMemoNativeInstant as instant, parseNativeAdministrativeMemo } from "./administrative-memo-native.ts";
import type { AdministrativeMemoAuthentication } from "../administrative-memo.ts";
import type { AdministrativeMemoConfig, NativeAdministrativeMemo } from "../administrative-memo-records.ts";

export class AdministrativeMemoHistoryError extends Error {
  readonly kind: "malformed" | "mismatched" | "conflict" | "unavailable" | "forbidden" | "rateLimited";
  constructor(kind: AdministrativeMemoHistoryError["kind"]) { super("Administrative memo history unavailable"); this.kind = kind; }
}
export type AdministrativeMemoHistorySelection = Readonly<{
  patientId: string; sourceActionRef: string; createdFrom: string; createdThrough: string;
}>;
type Row = Record<string, unknown>;
const object = (v: unknown): Row | undefined => !!v && typeof v === "object" && !Array.isArray(v) ? v as Row : undefined;
const link = (v: unknown) => object(object(v)?.links)?.self;
const numeric = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);

/** Full bounded native collection observation only. No list row or absence
 * grants permission to disclose a memo, write a record or resume an action. */
export async function readAdministrativeMemoHistory(selection: AdministrativeMemoHistorySelection & Readonly<{
  base: string; config: AdministrativeMemoConfig; authentication: AdministrativeMemoAuthentication;
}>, load: (url: string) => Promise<unknown>, clock: () => string): Promise<Readonly<{
  scanned: number; inventory: readonly string[]; match?: NativeAdministrativeMemo;
}>> {
  const { base, patientId, createdFrom, createdThrough } = selection;
  function fail(kind: AdministrativeMemoHistoryError["kind"] = "malformed"): never { throw new AdministrativeMemoHistoryError(kind); }
  const urlFor = (page: number) => {
    const q = new URLSearchParams({ page: String(page), per_page: "100", sort: "id:asc" });
    for (const filter of [`patient_id:=${patientId}`, "category_code:=12", "type_code:=3", "archived_at:*", `created_at:>=${createdFrom}`, `created_at:<=${createdThrough}`]) q.append("q[]", filter);
    return `${base}/communications?${q}`;
  };
  const sameUrl = (actual: unknown, expected: string) => {
    if (typeof actual !== "string") return false;
    try {
      const a = new URL(actual), e = new URL(expected);
      return a.origin === e.origin && a.pathname === e.pathname && !a.hash && !a.username && !a.password &&
        JSON.stringify([...a.searchParams.entries()].sort()) === JSON.stringify([...e.searchParams.entries()].sort());
    } catch { return false; }
  };
  let total: number | undefined, scanned = 0, previous = 0n, match: NativeAdministrativeMemo | undefined;
  const inventory: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const raw = object(await load(urlFor(page))), count = raw?.total_entries, rows = raw?.communications;
    if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 500 || !Array.isArray(rows) || total !== undefined && count !== total) fail();
    total = count as number;
    if (!Array.isArray(rows) || rows.length !== Math.min(100, total - scanned)) fail();
    const links = object(raw?.links);
    if (raw?.links !== undefined && !links || links?.self !== undefined && !sameUrl(links.self, urlFor(page)) ||
        links?.next !== undefined && links.next !== null && (scanned + rows!.length >= total || !sameUrl(links.next, urlFor(page + 1))) ||
        links?.previous !== undefined && links.previous !== null && (page === 1 || !sameUrl(links.previous, urlFor(page - 1)))) fail();
    for (const value of rows!) {
      const row = object(value), createdAt = instant(row?.created_at), updatedAt = instant(row?.updated_at), archivedAt = row?.archived_at === null ? null : instant(row?.archived_at);
      if (!row || !numeric(row.id) || BigInt(row.id) <= previous || link(row) !== `${base}/communications/${row.id}` || link(row.patient) !== `${base}/patients/${patientId}` ||
          row.category_code !== 12 || row.type_code !== 3 || row.confidential !== null && typeof row.confidential !== "boolean" ||
          row.direction_code !== null && row.direction_code !== 1 && row.direction_code !== 2 ||
          row.content !== null && (typeof row.content !== "string" || row.content.length > 65536) ||
          !createdAt || !updatedAt || createdAt < createdFrom || createdAt > createdThrough || createdAt > updatedAt ||
          Date.parse(updatedAt) > Date.parse(clock()) + 30000 || archivedAt === undefined || archivedAt !== null && archivedAt > updatedAt) fail();
      previous = BigInt(row!.id as string); scanned++;
      inventory.push(createHash("sha256").update(JSON.stringify([row!.id, link(row!), link(row!.patient), createdAt, updatedAt, archivedAt,
        row!.category_code, row!.type_code, row!.confidential, row!.direction_code, row!.content])).digest("hex"));
      if (typeof row!.content !== "string" || !row!.content.includes("Abby administrative memo v1")) continue;
      const decoded = decodeAdministrativeMemo(row!.content); if (!decoded.ok) fail();
      const found = parseNativeAdministrativeMemo(row, { base, config: selection.config, authentication: selection.authentication,
        clock, patientId, actionRef: decoded.value.actionRef });
      if (!found) fail("mismatched");
      if (found.memo.sourceActionRef !== selection.sourceActionRef) continue;
      if (match) fail("conflict"); match = found;
    }
    if (scanned === total) return Object.freeze({ scanned, inventory: Object.freeze(inventory), ...(match ? { match } : {}) });
  }
  return fail();
}
