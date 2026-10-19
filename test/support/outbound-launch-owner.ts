import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { outboundContactSourceFixture } from "./outbound-contact-source.ts";
import { value } from "./outbound-records.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { encodeOutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
import { outboundLaunchRecordOwnerBinding } from "../../src/cliniko/outbound-launch-records.ts";
import { OwnerFileOutboundCampaign } from "../../src/standalone/owner-file-outbound-campaign.ts";
import type { OutboundCampaignApproval } from "../../src/standalone/owner-file-outbound-campaign.ts";
import { ClinikoOutboundLaunchOwner, outboundLaunchOwnerBinding } from "../../src/standalone/cliniko-outbound-launch-owner.ts";
import type { OutboundLaunchAuthority, OutboundLaunchProvider } from "../../src/standalone/cliniko-outbound-launch-owner.ts";
import type { OutboundEffectBarrier } from "../../src/core/outbound-effect-barrier.ts";
import type { OutboundCapacity } from "../../src/core/outbound-capacity.ts";
import { outboundCapacityOwnerBinding } from "../../src/core/outbound-capacity.ts";

export async function outboundLaunchOwnerFixture(options: {
  apiKey?: string; scope?: import("../../src/core/model.ts").LocationScope;
  budget?: import("../../src/cliniko/read-budget.ts").ClinikoRequestBudget;
  effectFactory?(scope: Parameters<OutboundEffectBarrier["matches"]>[0], owner: string): OutboundEffectBarrier;
  capacityFactory?(scope: Parameters<OutboundCapacity["matches"]>[0], owner: string): OutboundCapacity;
  runtime?: { ClinikoOutboundLaunchOwner: typeof ClinikoOutboundLaunchOwner; OwnerFileOutboundCampaign: typeof OwnerFileOutboundCampaign };
} = {}) {
  const f = await outboundContactSourceFixture({ ...(options.apiKey ? { apiKey: options.apiKey } : {}), ...(options.scope ? { scope: options.scope } : {}) }), runtime = options.runtime ?? { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign };
  try {
    const base = "https://api.au5.cliniko.com/v1", path = join(dirname(f.definitionConfig.path), "campaign.json");
    const original = { ...f.request, actionRef: randomUUID(), effectRef: randomUUID(), approvalRef: randomUUID(), campaignRef: randomUUID() };
    const approval: OutboundCampaignApproval = { scope: original.scope, revision: "outbound-1", approverRef: f.state.account!.actor.actorRef,
      approvedAt: "2026-11-01T00:00:00.000Z", effectiveFrom: "2026-11-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z",
      approved: true, enabled: true, campaignRef: original.campaignRef, purpose: "followUp", providerRef: "synthetic-provider", maximumConcurrent: 1,
      audience: { kind: "nativeRecipientRequests", businessId: original.businessId, credentialFingerprint: original.credentialFingerprint,
        outboundRecallTypeId: "61", recordPolicyDigest: "d".repeat(64) }, schedule: original.schedule };
    await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
    const campaign = value(await runtime.OwnerFileOutboundCampaign.capture({ path, scope: original.scope, directory: f.directory,
      clock: () => f.state.now }, new AbortController().signal));
    const request = { ...original, policy: { version: approval.revision, digest: campaign.bindingFingerprint() } };
    const row = { id: "30", links: { self: `${base}/recalls/30` }, patient: { links: { self: `${base}/patients/${request.patientId}` } },
      recall_type: { links: { self: `${base}/recall_types/61` } }, notes: value(encodeOutboundRecipientRequest(request)), recall_at: "2026-11-02",
      recalled: false, recalled_at: null, archived_at: null, created_at: request.requestedAt, updated_at: request.requestedAt };
    f.controls.rows.push(row); f.controls.rows.sort((a, b) => Number(a.id) - Number(b.id));
    let claims = 0, posts = 0, next = 200, live = true, denied: string | undefined;
    const budget = new ClinikoReadBudget(180, () => Date.parse(f.state.now));
    const physical = options.budget ?? budget;
    const shared = { claim: () => { claims++; return physical.claim(); }, observe429: physical.observe429.bind(physical),
      ...(physical.checkHeadroom ? { checkHeadroom: physical.checkHeadroom.bind(physical) } : {}) };
    const native: typeof fetch = async (input, init) => {
      if (init?.method !== "POST") return f.port(input, init);
      assert.equal(String(input), `${base}/recalls`); posts++;
      const body = JSON.parse(String(init.body)); assert.equal(body.recall_type_id, "62");
      const id = String(next++), made = { id, links: { self: `${base}/recalls/${id}` }, patient: { links: { self: `${base}/patients/${body.patient_id}` } },
        recall_type: { links: { self: `${base}/recall_types/62` } }, notes: body.notes, recall_at: body.recall_at,
        recalled: false, recalled_at: null, archived_at: null, created_at: f.state.now, updated_at: f.state.now };
      f.controls.rows.push(made); return controls.retainResponse ? controls.retainResponse(made) : Response.json(made, { status: 201 });
    };
    const requests = { scope: request.scope, apiKey: f.config.apiKey, contactEmail: f.config.contactEmail, businessId: request.businessId,
      outboundRecallTypeId: "61", recordPolicyDigest: "d".repeat(64), rateBudget: shared, clock: () => f.state.now };
    const attempts = { ...requests, outboundAttemptRecallTypeId: "62", attemptPolicyDigest: "f".repeat(64) };
    const config = { requests, attempts, contact: { ...f.config, rateBudget: shared }, campaignRef: request.campaignRef, campaign,
      maximumNativeRequests: 150, dispatchWindowMs: 10_000, deadlineMs: 15_000 };
    const burned = new Set<string>(), held = new Set<string>(), used = new Set<string>(), released = new Set<string>();
    const memoryEffect = (scope: typeof request.scope, owner: string): OutboundEffectBarrier => ({
      matches: (s, b) => JSON.stringify(s) === JSON.stringify(scope) && b === owner,
      claimOnce: async ref => { const claimed = !burned.has(ref); burned.add(ref); return { ok: true, value: { claimed } }; } });
    const effects = options.effectFactory?.(request.scope, outboundLaunchOwnerBinding(config)!) ?? memoryEffect(request.scope, outboundLaunchOwnerBinding(config)!);
    const attemptEffects = options.effectFactory?.(request.scope, outboundLaunchRecordOwnerBinding(attempts)!) ?? memoryEffect(request.scope, outboundLaunchRecordOwnerBinding(attempts)!);
    const capacity: OutboundCapacity = options.capacityFactory?.(request.scope, outboundCapacityOwnerBinding(request.campaignRef)!) ?? {
      matches: (s, b) => JSON.stringify(s) === JSON.stringify(request.scope) && b === outboundCapacityOwnerBinding(request.campaignRef),
      acquireOnce: async (ref, maximum) => {
        if (used.has(ref)) return { ok: true, value: { kind: "alreadyUsed" } };
        if (held.size >= maximum) return { ok: true, value: { kind: "full" } };
        used.add(ref); held.add(ref); return { ok: true, value: { kind: "acquired" } };
      }, releaseOnce: async (ref, beforeRelease) => { if (beforeRelease && beforeRelease() !== true) return { ok: false, error: { kind: "forbidden" } }; const changed = held.delete(ref); if (changed) released.add(ref); return { ok: true, value: { released: changed } }; },
    };
    const calls: { effectRef: string; capacityAllocationRef: string; number: string; profileRef: string }[] = [];
    const controls: { providerRef: string; providerDigest: string; mode: "accepted" | "unknown" | "loseAfterAck";
      beforeEdge?: () => void | Promise<void>; afterAck?: () => void | Promise<void>;
      retainResponse?: (row: Record<string, unknown>) => Response | Promise<Response> } = {
      providerRef: approval.providerRef, providerDigest: "e".repeat(64), mode: "accepted" };
    const provider: OutboundLaunchProvider = {
      binding: () => ({ ref: controls.providerRef, bindingDigest: controls.providerDigest, profileRef: "generic-clinic-greeting" }),
      async launchOnce(payload, _signal, beforeSend, acknowledged) {
        await controls.beforeEdge?.(); if (!await beforeSend()) return { kind: "definitiveUnsent" };
        calls.push(payload);
        if (controls.mode === "unknown") throw new Error("Synthetic private provider response lost");
        acknowledged(payload.effectRef); await controls.afterAck?.();
        if (controls.mode === "loseAfterAck") throw new Error("Synthetic private observer failure");
        return { kind: "accepted", effectRef: payload.effectRef };
      },
    };
    const authority: OutboundLaunchAuthority = { allows: async q => q.operation !== denied, current: () => live };
    const ports: Parameters<typeof ClinikoOutboundLaunchOwner.create>[1] = { request: { allows: async () => true, current: () => live }, attempt: { allows: async () => true, current: () => live, producerAdmitted: async () => true },
      history: { allowsHistoryRead: async () => true, allowsRecordRead: async () => true, current: () => live },
      contact: f.authority, contactDefinition: f.definition, authority, provider, effects, attemptEffects, capacity, native };
    const make = () => runtime.ClinikoOutboundLaunchOwner.create(config, ports), owner = value(make());
    const binding = { recallRef: "cliniko:recall:30", actionRef: request.actionRef, patientId: request.patientId };
    return { ...f, contactControls: f.controls, request, requestRow: row, config, ports, owner, binding, native, controls, calls, burned, held, used, released, budget,
      get claims() { return claims; }, get posts() { return posts; }, make,
      launch: (signal = new AbortController().signal) => owner.launchOnce(binding, signal),
      deny: (operation: string) => { denied = operation; }, retire: () => { live = false; },
      cancelCampaign: () => writeFile(path, JSON.stringify({ ...approval, enabled: false }), { mode: 0o600 }) };
  } catch (error) { await f.close(); throw error; }
}
