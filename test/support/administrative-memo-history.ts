import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AdministrativeMemoAuthentication } from "../../src/cliniko/administrative-memo.ts";
import { ClinikoAdministrativeMemos, administrativeMemoRecordBinding } from "../../src/cliniko/administrative-memo-records.ts";
import type { AdministrativeMemoConfig, AdministrativeMemoQuery } from "../../src/cliniko/administrative-memo-records.ts";
import { ClinikoAdministrativeMemoHistory } from "../../src/cliniko/administrative-memo-history.ts";
import type { AdministrativeMemoHistoryQuery } from "../../src/cliniko/administrative-memo-history.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { ok } from "../../src/core/model.ts";
import { administrativeMemoInput } from "./administrative-memo.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

/** Synthetic native transport and clinic grants. Cold readers have no writer
 * or reference cache; they see only complete GET collections under new grants. */
export function administrativeMemoHistoryFixture(humans = 0, deadlineMs = 500) {
  const input = administrativeMemoInput(), authentication = new AdministrativeMemoAuthentication(randomBytes(32));
  const memo = resultValue(authentication.sign(input)), state = { now: input.recordedAt, collection: true, record: true, current: true,
    mode: "accepted" as "accepted" | "lostStored" | "lostUnstored", hold: undefined as Promise<void> | undefined,
    response: undefined as ((body: Record<string, unknown>, get: number, url: URL) => Response) | undefined,
    before: undefined as ((get: number) => void) | undefined };
  const rows = new Map<string, Record<string, unknown>>(), requests: { method: string; url: string }[] = [], consumed = new Set<string>();
  let nativeClaims = 0, gets = 0;
  const actual = new ClinikoReadBudget(180, () => Date.parse(state.now));
  const budget = { claim: () => { nativeClaims++; return actual.claim(); }, observe429: actual.observe429.bind(actual) };
  const config: AdministrativeMemoConfig = { scope: input.scope, businessId: input.businessId, apiKey: "synthetic-memo-au5", contactEmail: "ops@example.invalid",
    authorRef: input.authorRef, policy: input.policy, rateBudget: budget, clock: () => state.now, deadlineMs };
  const makeRow = (id: string, content: string, confidential: boolean | null) => ({ id, content, confidential, patient_id: input.patientId,
    category_code: 12, type_code: 3, direction_code: 2, archived_at: null, created_at: state.now, updated_at: state.now,
    links: { self: `https://api.au5.cliniko.com/v1/communications/${id}` }, patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${input.patientId}` } } });
  for (let i = 1; i <= humans; i++) rows.set(String(i), makeRow(String(i), `Unrelated human memo ${i}`, false));
  const port: typeof fetch = async (url, init) => {
    const u = new URL(String(url)); assert.equal(u.origin, "https://api.au5.cliniko.com"); assert.equal(u.pathname, "/v1/communications");
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal); assert.match(new Headers(init.headers).get("authorization")!, /^Basic /);
    const method = init?.method ?? "GET"; requests.push({ method, url: u.href });
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)), row = { ...makeRow("701", body.content, body.confidential), ...body };
      if (state.mode !== "lostUnstored") rows.set("701", structuredClone(row));
      if (state.mode !== "accepted") throw Error("Synthetic response lost after possibly stored memo");
      return Response.json(row, { status: 201 });
    }
    assert.equal(method, "GET"); gets++; state.before?.(gets);
    assert.equal(u.searchParams.get("per_page"), "100"); assert.equal(u.searchParams.get("sort"), "id:asc");
    assert.deepEqual(u.searchParams.getAll("q[]"), [`patient_id:=${input.patientId}`, "category_code:=12", "type_code:=3", "archived_at:*",
      `created_at:>=${selection.createdFrom}`, `created_at:<=${selection.createdThrough}`]);
    const page = Number(u.searchParams.get("page")); assert.ok(page >= 1 && page <= 5);
    const all = [...rows.values()].sort((a, b) => BigInt(String(a.id)) < BigInt(String(b.id)) ? -1 : 1);
    const body = { communications: structuredClone(all.slice((page - 1) * 100, page * 100)), total_entries: all.length };
    return state.response?.(body, gets, u) ?? Response.json(body);
  };
  const owner = administrativeMemoRecordBinding(config, authentication)!;
  const write = resultValue(ClinikoAdministrativeMemos.create(config, authentication,
    { allows: async () => true, current: () => true, producerAdmitted: async () => true },
    { matches: (scope, selected) => JSON.stringify(scope) === JSON.stringify(config.scope) && selected === owner,
      claimOnce: async ref => { const claimed = !consumed.has(ref); consumed.add(ref); return ok({ claimed }); } }, port));
  const queries: (AdministrativeMemoQuery | AdministrativeMemoHistoryQuery)[] = [];
  const authority = { allowsHistoryRead: async (q: AdministrativeMemoHistoryQuery) => { queries.push(q); await state.hold; return state.collection && q.patientId === input.patientId; },
    allowsRecordRead: async (q: AdministrativeMemoQuery) => { queries.push(q); return state.record; }, current: () => state.current };
  const fresh = () => resultValue(ClinikoAdministrativeMemoHistory.create(config, authentication, authority, port));
  const selection = { patientId: input.patientId, sourceActionRef: input.sourceActionRef,
    createdFrom: new Date(Date.parse(state.now) - 3600000).toISOString(), createdThrough: state.now };
  return { input, memo, authentication, config, state, rows, requests, consumed, actual, write, port, authority, queries, fresh, selection,
    makeRow, get claims() { return nativeClaims; }, get gets() { return gets; } };
}
