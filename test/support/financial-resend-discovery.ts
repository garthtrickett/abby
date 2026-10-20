import assert from "node:assert/strict";
import { ClinikoFinancialWorkDiscovery } from "../../src/cliniko/financial-work-discovery.ts";
import { ClinikoFinancialPendingDiscovery } from "../../src/cliniko/financial-pending-discovery.ts";
import { encodeFinancialResendRequest } from "../../src/cliniko/financial-resend-request.ts";
import { fixture, value, observation, now, base } from "./financial-retention.ts";
import { resendRequestValue } from "./financial-resend.ts";
export const resendDiscoveryWindow = { createdFrom: "2026-11-01T09:30:00.000Z", createdThrough: now };
export function resendDiscoveryFixture() {
  const f = fixture(); f.seedIntent(); const source = f.rows.get("30")!; source.recalled_at = null;
  const obs = { ...source, id: "31", links: { self: `${base}/recalls/31` }, notes: observation(f.intent) };
  const request = resendRequestValue(f.intent), native: Record<string, unknown> = { ...source, id: "33", links: { self: `${base}/recalls/33` }, notes: value(encodeFinancialResendRequest(request)) };
  f.rows.set("31", obs); f.rows.set("33", native);
  let recordsAllowed = true; const methods: string[] = [];
  const port: typeof fetch = async (input, init) => {
    methods.push(init?.method ?? "GET"); const url = new URL(String(input));
    if (url.pathname !== "/v1/recalls") return f.port(input, init);
    const filters = url.searchParams.getAll("q[]"), pending = filters.includes("recalled_at:!?");
    const after = filters.find(v => v.startsWith("created_at:>="))?.slice(13), before = filters.find(v => v.startsWith("created_at:<="))?.slice(13);
    const rows = [...f.rows.values()].filter(row => (!pending || row.recalled === false && row.recalled_at === null && row.archived_at === null) &&
      (!after || String(row.created_at) >= after) && (!before || String(row.created_at) <= before));
    const page = Number(url.searchParams.get("page")); return Response.json({ total_entries: rows.length, recalls: rows.slice((page-1)*100, page*100) });
  };
  const scanner = value(ClinikoFinancialWorkDiscovery.create(f.config, { allowsAccountRead: async () => true,
    allowsRecordRead: async q => q.actionRef !== request.actionRef || recordsAllowed, current: () => true }, port));
  const pending = value(ClinikoFinancialPendingDiscovery.create(f.config, { allowsPendingRead: async () => true,
    allowsRecordRead: async q => q.actionRef !== request.actionRef || recordsAllowed, current: () => true }, port));
  return { ...f, source, obs, request, native, scanner, pending, methods, denyRequest: () => { recordsAllowed = false; } };
}
