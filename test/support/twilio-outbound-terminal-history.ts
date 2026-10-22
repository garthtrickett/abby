import assert from "node:assert/strict";
import { ClinikoTwilioOutboundTerminalHistory } from "../../src/cliniko/twilio-outbound-terminal-history.ts";
import type { TwilioTerminalHistoryAuthority } from "../../src/cliniko/twilio-outbound-terminal-history.ts";
import { encodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { twilioOutboundTerminalObservationRecordsFixture } from "./twilio-outbound-terminal-observation-records.ts";
import { value } from "./outbound-records.ts";
const signal = () => new AbortController().signal;
export async function twilioTerminalHistoryFixture() {
  const f = await twilioOutboundTerminalObservationRecordsFixture(); value(await f.retain());
  const id = f.context.original.recallRef.split(":").at(-1)!, row = structuredClone(f.native.rows.get("30")!);
  Object.assign(row, { id, notes: value(encodeOutboundLaunchAttempt(f.context.original.attempt)), links: { self: `https://api.au5.cliniko.com/v1/recalls/${id}` },
    recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/62" } }, created_at: f.context.original.attempt.attemptedAt, updated_at: f.context.original.attempt.attemptedAt });
  f.native.rows.set(id, row);
  const attempts = { ...f.config, outboundAttemptRecallTypeId: "62", attemptPolicyDigest: "b".repeat(64) };
  const state: { live: boolean; pages: number; queries: Parameters<TwilioTerminalHistoryAuthority["current"]>[0][];
    grant?: (q: Parameters<TwilioTerminalHistoryAuthority["current"]>[0]) => boolean | Promise<boolean>;
    page?: (rows: Record<string, unknown>[], page: number) => Response | Promise<Response> } = { live: true, pages: 0, queries: [] };
  const allow = async (q: Parameters<TwilioTerminalHistoryAuthority["current"]>[0]) => { state.queries.push(q); return state.grant ? state.grant(q) : true; };
  const authority: TwilioTerminalHistoryAuthority = { allowsHistoryRead: allow, allowsObservationRead: allow, allowsAttemptRead: allow, current: () => state.live };
  const wire: typeof fetch = async (input, init) => {
    const u = new URL(String(input)); if (u.pathname !== "/v1/recalls") return f.native.port(input, init);
    assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error"); assert.deepEqual(u.searchParams.getAll("q[]"), ["archived_at:*"]);
    assert.equal(new Headers(init.headers).get("authorization"), `Basic ${Buffer.from(`${f.config.apiKey}:`).toString("base64")}`);
    state.pages++; const page = Number(u.searchParams.get("page")), rows = [...f.native.rows.values()].sort((a, b) => Number(a.id) - Number(b.id));
    return state.page ? state.page(rows, page) : Response.json({ recalls: rows.slice((page - 1) * 100, page * 100), total_entries: rows.length });
  };
  const identity = { effectRef: f.context.original.attempt.effectRef, capacityAllocationRef: f.context.original.attempt.capacityAllocationRef! };
  const make = (auth = f.auth) => value(ClinikoTwilioOutboundTerminalHistory.create({ observations: f.config, attempts }, auth, authority, wire));
  return { ...f, originalRow: row, attempts, historyState: state, historyAuthority: authority, historyPort: wire, identity, makeTerminalHistory: make,
    find: () => make().findForRuntime(identity, f.observation.accountSid, signal()) };
}
