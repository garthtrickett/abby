import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { twilioOutboundStopRecoveryFixture } from "./twilio-outbound-stop-recovery.ts";
import { value } from "./outbound-records.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { approvedSyntheticPolicy } from "./approved-voice.ts";
import { outboundConversationProfileRef } from "../../src/voice/outbound-voice-entry.ts";
import type { OutboundConversationApproval } from "../../src/voice/outbound-voice-entry.ts";
import type { OutboundRecordConfig } from "../../src/cliniko/outbound-recipient-records.ts";
import { twilioTerminalObservationProfileBinding } from "../../src/standalone/twilio-outbound-terminal-observation.ts";
import { TwilioOutboundStatusDelivery } from "../../src/standalone/twilio-outbound-status-delivery.ts";

export async function twilioStatusDeliveryFixture(options: { missingReport?: boolean; maximumNativeRequests?: number; notificationAck?: "stored" | "unstored"; deadlineMs?: number } = {}) {
  const key = Buffer.alloc(32, 43); let approval!: OutboundConversationApproval;
  const observationsFor = (r: OutboundRecordConfig) => ({ ...r, outboundTerminalObservationRecallTypeId: "66", terminalObservationPolicyDigest: "a".repeat(64) });
  const f = await twilioOutboundStopRecoveryFixture({ profileRef: r => {
    approval = { purpose: "outboundContact", runtimeConfigurationHash: "a".repeat(64), terminalObservationBinding: twilioTerminalObservationProfileBinding(observationsFor(r), key)!,
      policy: approvedSyntheticPolicy({ ...referenceDefaultPolicy(r.scope), automationEnabled: true,
        greeting: { scope: r.scope, version: "outbound-v1", ownerRef: "clinic-owner", approved: true, approvedText: "Hello, this is Abby calling on behalf of the clinic.",
          effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z" } }) };
    return outboundConversationProfileRef(approval)!;
  } });
  try {
    if (options.missingReport) f.contactControls.rows.splice(f.contactControls.rows.indexOf(f.reportRow), 1);
    const state = { source: true, record: true, producer: true, history: true, current: true };
    const posts: Record<string, unknown>[] = [], burned = new Map<string, string>(); let next = 900;
    const native: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "GET" && url.pathname === "/v1/recalls" && url.searchParams.getAll("q[]").join(",") === "archived_at:*") {
        assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init.redirect, "error");
        assert.equal(url.searchParams.get("per_page"), "100"); assert.equal(url.searchParams.get("sort"), "id:asc");
        const page = Number(url.searchParams.get("page")); assert.ok(Number.isSafeInteger(page) && page >= 1);
        const rows = [...f.contactControls.rows].sort((a, b) => Number(a.id) - Number(b.id));
        return Response.json({ recalls: rows.slice((page - 1) * 100, page * 100), total_entries: rows.length });
      }
      const body = init?.method === "POST" ? JSON.parse(String(init.body)) : undefined;
      if (body?.recall_type_id !== "66") return f.recoveryPorts.native!(input, init);
      assert.equal(url.pathname, "/v1/recalls"); assert.equal(body.patient_id, f.attempt.patientId); assert.equal(body.recalled, false); posts.push(body);
      if (options.notificationAck === "unstored") throw Error("Unobserved notification write");
      const id = String(next++), row = { ...f.reportRow, id, notes: body.notes, recall_at: body.recall_at,
        recalled: false, recalled_at: null, archived_at: null, created_at: f.state.now, updated_at: f.state.now,
        patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${body.patient_id}` } },
        recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/66" } }, links: { self: `https://api.au5.cliniko.com/v1/recalls/${id}` } };
      f.contactControls.rows.push(row);
      if (options.notificationAck === "stored") throw Error("Lost notification response");
      return Response.json(row, { status: 201 });
    };
    const observations = observationsFor(f.recoveryConfig.stop.requests), config = {
      notifications: { config: { runtime: f.recoveryPorts.runtime, observations, attempts: f.recoveryConfig.stop.attempts, key, maximumNativeRequests: 180 },
        ports: { source: { read: async () => ({ ok: true as const, value: approval }), current: () => state.source },
          record: { allows: async () => state.record, current: () => state.current, producerAdmitted: async () => state.producer }, native,
          effects: (scope: typeof observations.scope, owner: string) => ({ matches: (s: typeof scope, b: string) => isDeepStrictEqual(s, scope) && owner === b,
            claimOnce: async (ref: string) => { const prior = burned.get(ref);
              if (prior && prior !== owner) return { ok: false as const, error: { kind: "bindingMismatch" as const } };
              if (prior) return { ok: true as const, value: { claimed: false } }; burned.set(ref, owner); return { ok: true as const, value: { claimed: true } }; } }),
          history: { allowsHistoryRead: async () => state.history, allowsObservationRead: async () => state.history,
            allowsAttemptRead: async () => state.history, current: () => state.current } } },
      stop: { config: f.recoveryConfig, ports: { ...f.recoveryPorts, native } },
      maximumNativeRequests: options.maximumNativeRequests ?? 180, ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }) };
    const make = () => TwilioOutboundStatusDelivery.create(config), delivery = value(make());
    return { ...f, get claims() { return f.claims; }, delivery, deliveryConfig: config, makeDelivery: make, notificationState: state, notificationPosts: posts, notificationBurned: burned,
      receive: (patch: Record<string, string> = {}, signal = new AbortController().signal) => delivery.receiveStatus(f.request(patch), signal) };
  } catch (e) { await f.close(); throw e; }
}
