import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { outboundLaunchOwnerFixture } from "./outbound-launch-owner.ts";
import { value } from "./outbound-records.ts";
import { decodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { decodeOutboundContactReview } from "../../src/cliniko/outbound-contact-review.ts";
import { contactSourceBinding, contactSourceSelection } from "../../src/cliniko/internal/outbound-contact-source-context.ts";
import { outboundDncRecordBinding } from "../../src/cliniko/outbound-dnc-records.ts";
import { OwnerFileOutboundDncPolicy } from "../../src/standalone/owner-file-outbound-dnc-policy.ts";
import type { OutboundDncPolicyApproval } from "../../src/standalone/owner-file-outbound-dnc-policy.ts";
import { ClinikoOutboundStopOwner } from "../../src/standalone/cliniko-outbound-stop-owner.ts";
import type { OutboundStopProvider, OutboundStopQuery } from "../../src/standalone/cliniko-outbound-stop-owner.ts";

export async function outboundStopOwnerFixture(options: NonNullable<Parameters<typeof outboundLaunchOwnerFixture>[0]> & {
  StopOwner?: typeof ClinikoOutboundStopOwner; Policy?: typeof OwnerFileOutboundDncPolicy;
} = {}) {
  const { StopOwner = ClinikoOutboundStopOwner, Policy = OwnerFileOutboundDncPolicy, ...rest } = options, f = await outboundLaunchOwnerFixture(rest);
  try {
    assert.equal(value(await f.launch()).kind, "accepted");
    const row = f.contactControls.rows.find(r => (r.recall_type as { links: { self: string } }).links.self.endsWith("/62"))!;
    const attempt = value(decodeOutboundLaunchAttempt(row.notes));
    const binding = { recallRef: `cliniko:recall:${row.id}`, actionRef: attempt.actionRef, patientId: attempt.patientId };
    const dnc = { source: f.config.contact, automationPrincipalRef: "clinic-approved-optout-automation" };
    const providerBinding = { ref: attempt.provider.ref, bindingDigest: attempt.provider.bindingDigest };
    const { source: _source, ...common } = f.approval;
    const approval: OutboundDncPolicyApproval = { ...common, revision: "automatic-dnc-v1", dnc: {
      sourceBinding: contactSourceBinding(contactSourceSelection(dnc.source)), automationPrincipalRef: dnc.automationPrincipalRef,
      provider: providerBinding, participant: "anyAtDialledNumber", consent: "unknown", doNotCall: "blocked", reconsent: "clinicApprovalOnly" } };
    const path = join(dirname(f.definitionConfig.path), "automatic-stop.json"); await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
    const policy = value(await Policy.capture({ path, scope: dnc.source.scope, directory: f.directory, clock: () => f.state.now }, new AbortController().signal));
    const state: { allow: boolean; record: boolean; producer: boolean; live: boolean; kind: "stop" | "none" | "unknown";
      inspectCount: number; beforeInspect?: () => void | Promise<void>; beforeRecord?: () => void | Promise<void>; beforeStore?: () => void | Promise<void>;
      patch?: Record<string, unknown>; response?: (row: Record<string, unknown>) => Response | Promise<Response> } = {
      allow: true, record: true, producer: true, live: true, kind: "stop", inspectCount: 0 };
    const queries: OutboundStopQuery[] = [], burned = new Set<string>(), posts: Record<string, unknown>[] = [];
    const ownerBinding = outboundDncRecordBinding(dnc)!;
    const effects = options.effectFactory?.(dnc.source.scope, ownerBinding) ?? {
      matches: (s: typeof dnc.source.scope, b: string) => JSON.stringify(s) === JSON.stringify(dnc.source.scope) && b === ownerBinding,
      claimOnce: async (ref: string) => { const claimed = !burned.has(ref); burned.add(ref); return { ok: true as const, value: { claimed } }; },
    };
    const native: typeof fetch = async (input, init) => {
      if (init?.method !== "POST") return f.native(input, init);
      const body = JSON.parse(String(init.body));
      if (body.recall_type_id !== dnc.source.contactReviewRecallTypeId) return f.native(input, init);
      const review = value(decodeOutboundContactReview(body.notes));
      assert.equal(body.patient_id, attempt.patientId); assert.equal(body.recalled, false);
      posts.push(body);
      await state.beforeStore?.();
      const retained = { ...f.row(review, "300"), recall_at: body.recall_at, created_at: f.state.now, updated_at: f.state.now };
      f.contactControls.rows.push(retained); return state.response ? state.response(retained) : Response.json(retained, { status: 201 });
    };
    const stoppedAt = f.state.now;
    const provider: OutboundStopProvider = { binding: () => ({ ...providerBinding }), inspectStop: async identity => {
      state.inspectCount++; await state.beforeInspect?.(); if (state.kind !== "stop") return { kind: state.kind };
      return { kind: "stop", ...identity, provider: providerBinding, number: f.request.recipient.number, participant: "anyAtDialledNumber",
        stoppedAt, observedAt: f.state.now, ...state.patch } as Awaited<ReturnType<OutboundStopProvider["inspectStop"]>>;
    } };
    const ports: Parameters<typeof ClinikoOutboundStopOwner.create>[1] = {
      attempt: f.ports.attempt, request: f.ports.request, contact: f.ports.contact, definition: f.definition,
      record: { allows: async () => { await state.beforeRecord?.(); return state.record; }, current: () => state.live, producerAdmitted: async () => state.producer },
      effects, provider, authority: { allows: async q => { queries.push(q); return state.allow; }, current: () => state.live }, native,
    };
    const config = { attempts: f.config.attempts, requests: f.config.requests, dnc, policy, maximumNativeRequests: 60, deadlineMs: 15000 };
    const make = () => StopOwner.create(config, ports), stopOwner = value(make());
    return { ...f, get claims() { return f.claims; }, row, attempt, stopBinding: binding, stopConfig: config, stopPorts: ports, stopState: state,
      policyPath: path, policyApproval: approval, policy, providerBinding, dncPosts: posts, dncBurned: burned, stopQueries: queries, nativeStop: native, makeStop: make,
      retainStop: (signal = new AbortController().signal) => stopOwner.retainStopOnce(binding, signal),
      replaceStopPolicy: (patch: Record<string, unknown>) => writeFile(path, JSON.stringify({ ...approval, ...patch })) };
  } catch (e) { await f.close(); throw e; }
}
