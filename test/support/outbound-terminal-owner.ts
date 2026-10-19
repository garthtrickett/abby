import assert from "node:assert/strict";
import { outboundLaunchOwnerFixture } from "./outbound-launch-owner.ts";
import { value } from "./outbound-records.ts";
import { decodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { ClinikoOutboundTerminalOwner } from "../../src/standalone/cliniko-outbound-terminal-owner.ts";
import type { OutboundTerminalProvider } from "../../src/standalone/cliniko-outbound-terminal-owner.ts";

export async function outboundTerminalOwnerFixture(options: NonNullable<Parameters<typeof outboundLaunchOwnerFixture>[0]> & { TerminalOwner?: typeof ClinikoOutboundTerminalOwner } = {}) {
  const { TerminalOwner = ClinikoOutboundTerminalOwner, ...launchOptions } = options;
  const f = await outboundLaunchOwnerFixture(launchOptions);
  try {
    assert.equal(value(await f.launch()).kind, "accepted");
    const row = f.contactControls.rows.find(r => (r.recall_type as { links: { self: string } }).links.self.endsWith("/62"))!;
    const attempt = value(decodeOutboundLaunchAttempt(row.notes));
    const transport = f.calls[0]!;
    assert.equal(transport.capacityAllocationRef, attempt.capacityAllocationRef);
    const binding = { recallRef: `cliniko:recall:${row.id}`, actionRef: attempt.actionRef, patientId: attempt.patientId };
    let lookupCount = 0;
    const state: { denied?: string; withdrawn?: string; readLive: boolean; provider: "terminal" | "active" | "unknown";
      afterLookup?: () => void | Promise<void>; beforeRelease?: () => void | Promise<void>;
      proofPatch?: Record<string, unknown> } = { readLive: true, provider: "terminal" };
    const provider: OutboundTerminalProvider = {
      binding: () => ({ ref: attempt.provider.ref, bindingDigest: attempt.provider.bindingDigest }),
      async inspectTerminal(query) {
        lookupCount++; await state.afterLookup?.();
        if (query.effectRef !== transport.effectRef || query.capacityAllocationRef !== transport.capacityAllocationRef) return { kind: "unknown" };
        if (state.provider !== "terminal") return { kind: state.provider };
        return { kind: "terminal", complete: true, ...query, provider: this.binding(), endedAt: f.state.now, observedAt: f.state.now,
          ...state.proofPatch } as Awaited<ReturnType<OutboundTerminalProvider["inspectTerminal"]>>;
      }
    };
    const authority = { allows: async (q: { operation: string }) => q.operation !== state.denied,
      current: (q: { operation: string }) => q.operation !== state.withdrawn };
    const ports = { record: { allows: f.ports.attempt.allows, current: () => state.readLive }, authority, provider,
      capacity: { matches: f.ports.capacity.matches.bind(f.ports.capacity), releaseOnce: async (ref: string, gate?: () => boolean) => {
        await state.beforeRelease?.(); return f.ports.capacity.releaseOnce(ref, gate);
      } }, native: f.native };
    const config = { attempts: f.config.attempts, campaignRef: f.request.campaignRef, capacityScope: f.request.scope,
      maximumNativeRequests: 8, deadlineMs: 15_000 };
    const make = () => value(TerminalOwner.create(config, ports));
    const owner = make();
    return { ...f, get claims() { return f.claims; }, get posts() { return f.posts; }, row, attempt, terminalBinding: binding, terminalConfig: config, terminalPorts: ports, stateTerminal: state, makeTerminal: make,
      inspect: (signal = new AbortController().signal) => owner.inspectAndRelease(binding, signal), get lookupCount() { return lookupCount; } };
  } catch (e) { await f.close(); throw e; }
}

