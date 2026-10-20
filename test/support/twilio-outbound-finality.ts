import assert from "node:assert/strict";
import { once } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { outboundCapacityOwnerBinding } from "../../src/core/outbound-capacity.ts";
import type { OutboundCapacity } from "../../src/core/outbound-capacity.ts";
import { outboundDncRecordBinding } from "../../src/cliniko/outbound-dnc-records.ts";
import { outboundContactOutcomeRecordBinding } from "../../src/cliniko/outbound-contact-outcome-records.ts";
import { TwilioOutboundReportAuthentication } from "../../src/cliniko/twilio-outbound-report.ts";
import { recoverTwilioOutboundFinality } from "../../src/standalone/cliniko-twilio-outbound-finality-recovery.ts";
import type { TwilioFinalityRecoveryPorts } from "../../src/standalone/cliniko-twilio-outbound-finality-recovery.ts";
import { twilioOutboundStopSpeechFixture } from "./twilio-outbound-stop-speech.ts";

type Options = NonNullable<Parameters<typeof twilioOutboundStopSpeechFixture>[0]>;
export async function twilioOutboundFinalityFixture(options: Omit<Options, "carrierRead"> = {}) {
  const callCapacities = new Map<string, OutboundCapacity>(), callHeld = new Set<string>(), callUsed = new Set<string>();
  const state = { live: true, allowed: true, source: true, provider: true, outcome: true, callRelease: true, contactRelease: true, child: false, active: false,
    outcomeResponse: "ack" as "ack" | "lostStored" | "lostUnstored", beforeOutcome: undefined as (() => void | Promise<void>) | undefined,
    beforeProvider: undefined as (() => void | Promise<void>) | undefined };
  let f: Awaited<ReturnType<typeof twilioOutboundStopSpeechFixture>>, reads = 0, nativeReads = 0;
  const capacityFactory = (scope: Parameters<NonNullable<Options["capacityFactory"]>>[0], owner: string): OutboundCapacity => {
    const capacity: OutboundCapacity = options.capacityFactory?.(scope, owner) ?? {
      matches: (s, o) => isDeepStrictEqual(s, scope) && o === owner,
      acquireOnce: async (id, maximum) => {
        if (callUsed.has(id)) return { ok: true, value: { kind: "alreadyUsed" } };
        if (callHeld.size >= maximum) return { ok: true, value: { kind: "full" } };
        callUsed.add(id); callHeld.add(id); return { ok: true, value: { kind: "acquired" } };
      },
      releaseOnce: async (id, current) => current && !current() ? { ok: false, error: { kind: "forbidden" } } : { ok: true, value: { released: callHeld.delete(id) } }
    };
    callCapacities.set(owner, capacity); return capacity;
  };
  const carrierRead: typeof fetch = async (input, init) => {
    reads++; await state.beforeProvider?.(); const u = new URL(String(input)), root = `/2010-04-01/Accounts/${f.carrier.accountSid}/Calls`;
    assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(u.origin, "https://api.twilio.com");
    assert.equal(new Headers(init.headers).get("authorization"), `Basic ${Buffer.from(`${f.carrier.accountSid}:${f.carrier.authToken}`).toString("base64")}`);
    if (u.pathname === root + ".json") {
      assert.deepEqual(u.searchParams.getAll("ParentCallSid"), [f.callSid]); const relative = u.pathname + u.search;
      return Response.json({ calls: state.child ? [{ sid: "CA" + "d".repeat(32), status: "completed" }] : [], next_page_uri: null, previous_page_uri: null,
        page: 0, page_size: 100, uri: relative, first_page_uri: relative });
    }
    assert.equal(u.pathname, root + "/" + f.callSid + ".json");
    return Response.json({ account_sid: f.carrier.accountSid, sid: f.callSid, to: f.request.recipient.number, from: f.carrier.from, direction: "outbound-api",
      parent_call_sid: null, uri: u.pathname, status: state.active ? "in-progress" : "completed", date_created: new Date(f.attempt.attemptedAt).toUTCString(),
      start_time: "Mon, 02 Nov 2026 00:00:00 GMT", end_time: "Mon, 02 Nov 2026 00:00:02 GMT", date_updated: "Mon, 02 Nov 2026 00:00:02 GMT" });
  };
  f = await twilioOutboundStopSpeechFixture({ ...options, capacityFactory, carrierRead });
  try {
    const outcomes = { ...f.config.stop.requests, outboundContactOutcomeRecallTypeId: "63", contactOutcomePolicyDigest: "d".repeat(64) };
    const outcomePosts: Record<string, unknown>[] = [];
    const native: typeof fetch = async (input, init) => {
      nativeReads++;
      if (init?.method !== "POST") return f.nativeSpeech(input, init); const body = JSON.parse(String(init.body));
      if (body.recall_type_id !== "63") return f.nativeSpeech(input, init);
      assert.equal(String(input), "https://api.au5.cliniko.com/v1/recalls"); assert.equal(body.patient_id, f.request.patientId); outcomePosts.push(body); await state.beforeOutcome?.();
      const row = { id: "400", links: { self: "https://api.au5.cliniko.com/v1/recalls/400" }, patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${body.patient_id}` } },
        recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/63" } }, notes: body.notes, recall_at: body.recall_at, recalled: false, recalled_at: null,
        archived_at: null, created_at: f.state.now, updated_at: f.state.now };
      if (state.outcomeResponse !== "lostUnstored") f.contactControls.rows.push(row);
      if (state.outcomeResponse !== "ack") throw Error("Synthetic native outcome acknowledgement lost");
      return Response.json(row, { status: 201 });
    };
    const { report: _write, reports: _history, effects: _effects, native: _native, ...stop } = f.ports;
    const ports: TwilioFinalityRecoveryPorts = {
      native, adapter: { runtime: f.runtime, authentication: new TwilioOutboundReportAuthentication(f.key, f.attempt.provider),
        history: { allowsHistoryRead: async () => state.allowed, allowsReportRead: async () => state.allowed, allowsAttemptRead: async () => state.allowed, current: () => state.live },
        closure: { allows: async q => q.operation === "approveExclusiveSingleRootProfile" ? state.source : state.provider, current: () => state.live } },
      contact: { stop: { ...stop, effects: f.effects(f.request.scope, outboundDncRecordBinding(f.config.stop.dnc)!) },
        outcomes: { allows: async () => state.outcome, current: () => state.live, producerAdmitted: async () => state.outcome },
        history: { allowsHistoryRead: async () => state.outcome, allowsRecordRead: async () => state.outcome, current: () => state.live },
        outcomeEffects: f.effects(f.request.scope, outboundContactOutcomeRecordBinding(outcomes)!), capacity: f.capacity,
        authority: { allows: async q => q.operation !== "releaseContactHold" || state.contactRelease, current: q => state.live && (q.operation !== "releaseContactHold" || state.contactRelease) } },
      call: { record: f.ports.attempt, capacity: callCapacities.get(outboundCapacityOwnerBinding(f.attempt.campaignRef)!)!,
        authority: { allows: async q => q.operation !== "releaseCapacity" || state.callRelease, current: q => state.live && (q.operation !== "releaseCapacity" || state.callRelease) } }
    };
    const config = { reports: f.reports, contact: { stop: f.config.stop, outcomes, account: f.account, guardRef: f.guardRef, capacityScope: f.request.scope, maximumNativeRequests: 100, deadlineMs: 15000 },
      call: { attempts: f.config.stop.attempts, campaignRef: f.attempt.campaignRef, capacityScope: f.request.scope, maximumNativeRequests: 10, deadlineMs: 15000 } };
    const binding = { recallRef: f.original().original.recallRef, actionRef: f.attempt.actionRef, patientId: f.attempt.patientId };
    const recover = () => recoverTwilioOutboundFinality(config, ports, binding, new AbortController().signal);
    async function speak() {
      const server = await f.listen(); const wire = await f.start(server);
      try { const closed = once(wire.socket, "close"); wire.sendTurn(); await closed; await f.finished; }
      finally { await server.close(); }
      f.state.now = "2026-11-02T00:00:03.000Z";
    }
    return { ...f, finalityConfig: config, finalityPorts: ports, finalityState: state, outcomePosts, recoverFinality: recover, speakStop: speak, callHeld,
      get admitted() { return f.admitted; }, get carrierCalls() { return f.carrierCalls; }, get claims() { return f.claims; },
      get providerReads() { return reads; }, get finalityNativeCalls() { return nativeReads; } };
  } catch (e) { await f.close(); throw e; }
}
