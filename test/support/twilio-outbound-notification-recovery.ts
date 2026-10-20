import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { outboundCapacityOwnerBinding } from "../../src/core/outbound-capacity.ts";
import { encodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { recoverTwilioOutboundNotification } from "../../src/standalone/cliniko-twilio-outbound-notification-recovery.ts";
import type { TwilioNotificationRecoveryPorts } from "../../src/standalone/cliniko-twilio-outbound-notification-recovery.ts";
import { twilioOutboundTerminalProducerFixture } from "./twilio-outbound-terminal-producer.ts";
import { value } from "./outbound-records.ts";

type NativeGrant = Parameters<TwilioNotificationRecoveryPorts["history"]["current"]>[0];
type ProviderGrant = Parameters<TwilioNotificationRecoveryPorts["closure"]["current"]>[0];
type Options = Pick<NonNullable<Parameters<typeof twilioOutboundTerminalProducerFixture>[0]>, "request" | "budget" | "effectsFactory"> & { lostAck?: "stored" | "unstored" };
export async function twilioNotificationRecoveryFixture(options: Options = {}) {
  const state = { history: true, decoded: true, record: true, nativeLive: true, source: true, provider: true, providerLive: true, release: true,
    child: false, active: false, reads: 0, pages: 0, releases: 0, beforeProvider: undefined as (() => void) | undefined,
    beforeRelease: undefined as (() => void) | undefined, beforeNative: undefined as ((path: string) => void) | undefined };
  let f: Awaited<ReturnType<typeof twilioOutboundTerminalProducerFixture>>;
  const carrierRead: typeof fetch = async (input, init) => {
    const u = new URL(String(input)), root = `/2010-04-01/Accounts/${f.config.accountSid}/Calls`;
    assert.equal(u.origin, "https://api.twilio.com"); assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), `Basic ${Buffer.from(`${f.config.accountSid}:${f.config.authToken}`).toString("base64")}`);
    state.reads++; state.beforeProvider?.();
    if (u.pathname === root + ".json") {
      assert.deepEqual([...u.searchParams], [["ParentCallSid", "CA" + "2".repeat(32)], ["PageSize", "100"], ["Page", "0"]]);
      return Response.json({ calls: state.child ? [{ sid: "CA" + "3".repeat(32) }] : [], next_page_uri: null, previous_page_uri: null,
        page: 0, page_size: 100, uri: u.pathname + u.search, first_page_uri: u.pathname + u.search });
    }
    assert.equal(u.pathname, root + "/CA" + "2".repeat(32) + ".json");
    return Response.json({ account_sid: f.config.accountSid, sid: "CA" + "2".repeat(32), to: f.payload.number, from: f.config.from,
      parent_call_sid: null, direction: "outbound-api", uri: u.pathname, status: state.active ? "in-progress" : "completed",
      date_created: "Sun, 01 Nov 2026 10:00:00 GMT", start_time: "Sun, 01 Nov 2026 10:00:05 GMT",
      end_time: "Sun, 01 Nov 2026 10:02:00 GMT", date_updated: "Sun, 01 Nov 2026 10:02:00 GMT" });
  };
  const { lostAck, ...source } = options;
  f = await twilioOutboundTerminalProducerFixture({ ...source, carrierRead, budget: source.budget ?? new ClinikoReadBudget(180, () => Date.parse("2026-11-01T10:03:00.000Z")),
    ...(lostAck ? { response: (row: Record<string, unknown>, method: string) => {
      if (method !== "POST") return Response.json(row);
      if (lostAck === "unstored") f.native.rows.delete(String(row.id));
      throw Error("Synthetic completed-notification acknowledgement lost");
    } } : {}) });
  const retained = value(await f.producer.observeStatus(f.request(), new AbortController().signal)); assert.equal(retained.kind, lostAck ? "uncertain" : "accepted");
  const a = f.original.attempt, originalRow = { id: "40", patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${a.patientId}` } }, recall_at: "2026-11-02", recalled: false, recalled_at: null, archived_at: null, notes: value(encodeOutboundLaunchAttempt(a)),
    links: { self: "https://api.au5.cliniko.com/v1/recalls/40" }, recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/62" } },
    created_at: a.attemptedAt, updated_at: a.attemptedAt };
  f.native.rows.set("40", originalRow);
  const attempts = { ...f.observations, outboundAttemptRecallTypeId: "62", attemptPolicyDigest: "b".repeat(64) };
  const native: typeof fetch = async (input, init) => {
    assert.equal(init?.method, "GET"); const u = new URL(String(input)); state.beforeNative?.(u.pathname);
    if (u.pathname !== "/v1/recalls") return f.native.port(input, init);
    assert.equal(u.origin, "https://api.au5.cliniko.com"); assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), `Basic ${Buffer.from(`${f.observations.apiKey}:`).toString("base64")}`);
    state.pages++; assert.deepEqual(u.searchParams.getAll("q[]"), ["archived_at:*"]);
    const rows = [...f.native.rows.values()].sort((a, b) => Number(a.id) - Number(b.id));
    const page = Number(u.searchParams.get("page")); return Response.json({ recalls: rows.slice((page - 1) * 100, page * 100), total_entries: rows.length });
  };
  const nativeQueries: NativeGrant[] = [], providerQueries: ProviderGrant[] = [], held = new Set<string>([a.capacityAllocationRef!]);
  const allow = async (q: NativeGrant) => { nativeQueries.push(q); return state.history && (!("observation" in q) || !q.observation || state.decoded); };
  const owner = outboundCapacityOwnerBinding(a.campaignRef)!;
  const ports: TwilioNotificationRecoveryPorts = { runtime: f.runtime, authentication: f.auth, native,
    history: { allowsHistoryRead: allow, allowsObservationRead: allow, allowsAttemptRead: allow, current: () => state.nativeLive },
    closure: { allows: async q => { providerQueries.push(q); return q.operation === "approveExclusiveSingleRootProfile" ? state.source : state.provider; }, current: () => state.providerLive },
    call: { record: { allows: async () => state.record, current: () => state.record },
      authority: { allows: async () => state.release, current: () => state.release },
      capacity: { matches: (scope, selected) => isDeepStrictEqual(scope, a.scope) && selected === owner,
        releaseOnce: async (id, gate) => { state.beforeRelease?.(); if (gate && gate() !== true) return { ok: false, error: { kind: "forbidden" } };
          state.releases++; return { ok: true, value: { released: held.delete(id) } }; } } } };
  const config = { observations: f.observations, call: { attempts, campaignRef: a.campaignRef, capacityScope: a.scope, maximumNativeRequests: 100, deadlineMs: 15000 } };
  const input = { recallRef: f.original.recallRef, actionRef: a.actionRef, patientId: a.patientId };
  const recover = (signal = new AbortController().signal) => recoverTwilioOutboundNotification(config, ports, input, signal);
  return { ...f, recoveryState: state, recoveryConfig: config, recoveryPorts: ports, recoveryInput: input, nativeQueries, providerQueries, held, originalRow, recover };
}
