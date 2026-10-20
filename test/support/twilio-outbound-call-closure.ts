import assert from "node:assert/strict";
import { TwilioAbbyOutboundRuntime } from "../../src/voice/twilio-outbound-runtime.ts";
import type { TwilioCallClosureQuery } from "../../src/voice/twilio-outbound-call-closure.ts";

export function callClosureFixture() {
  const accountSid = "AC" + "1".repeat(32), callSid = "CA" + "2".repeat(32), from = "+12025550110", number = "+12025550123";
  const path = `/2010-04-01/Accounts/${accountSid}/Calls`, rootPath = path + "/" + callSid + ".json";
  const childrenPath = path + ".json?" + new URLSearchParams({ ParentCallSid: callSid, PageSize: "100", Page: "0" });
  const raw = { account_sid: accountSid, sid: callSid, to: number, from, direction: "outbound-api", parent_call_sid: null, uri: rootPath, status: "completed",
    date_created: "Sun, 01 Nov 2026 10:00:00 +0000", start_time: "Sun, 01 Nov 2026 10:00:05 +0000", end_time: "Sun, 01 Nov 2026 10:02:00 +0000", date_updated: "Sun, 01 Nov 2026 10:02:00 +0000" };
  const children = { calls: [], next_page_uri: null, previous_page_uri: null, page: 0, page_size: 100, uri: childrenPath, first_page_uri: childrenPath };
  const state: { now: string; live: boolean; count: number; queries: TwilioCallClosureQuery[]; grant?: (q: TwilioCallClosureQuery) => boolean | Promise<boolean>;
    response?: (relative: string) => Response | Promise<Response> } = { now: "2026-11-01T10:04:00.000Z", live: true, count: 0, queries: [] };
  const port: typeof fetch = async (input, init) => {
    const u = new URL(String(input)); assert.equal(u.origin, "https://api.twilio.com"); assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), `Basic ${Buffer.from(`${accountSid}:synthetic-test-token`).toString("base64")}`);
    const relative = u.pathname + u.search; state.count++;
    if (state.response) return state.response(relative);
    assert.ok(relative === rootPath || relative === childrenPath); return Response.json(relative === rootPath ? raw : children);
  };
  const runtime = new TwilioAbbyOutboundRuntime({ ref: "twilio", profileRef: "abby-one-root", accountSid, authToken: "synthetic-test-token", from,
    publicAnswerUrl: "https://voice.example.invalid/answer", publicStatusUrl: "https://voice.example.invalid/status", publicStreamUrl: "wss://voice.example.invalid/stream",
    contextKey: Buffer.alloc(32, 11), deadlineMs: 1000, now: () => state.now }, port);
  const authority = { allows: async (q: TwilioCallClosureQuery) => { state.queries.push(q); return state.grant ? state.grant(q) : true; }, current: () => state.live };
  const input = { callSid, number, attemptedAt: "2026-11-01T10:00:00.123Z", stoppedAt: "2026-11-01T10:01:00.000Z", evidenceDigest: "d".repeat(64) };
  return { runtime, authority, state, raw, children, input, rootPath, childrenPath, inspect: () => runtime.createCallClosureReader().inspect(input, authority, new AbortController().signal) };
}
