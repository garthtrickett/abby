import assert from "node:assert/strict";
import { outboundLaunchOwnerFixture } from "./outbound-launch-owner.ts";
import { value } from "./outbound-records.ts";
import { bindOutboundVoiceRuntime } from "../../src/voice/outbound-runtime.ts";
import type { OutboundVoiceRuntimeAdapter } from "../../src/voice/outbound-runtime.ts";
import { ClinikoOutboundTerminalOwner } from "../../src/standalone/cliniko-outbound-terminal-owner.ts";
import { decodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";

/** Two synthetic trusted implementations, not live Twilio/Vapi integrations. */
export async function outboundRuntimeOwnersFixture(options: NonNullable<Parameters<typeof outboundLaunchOwnerFixture>[0]> & {
  engine: "abby" | "vapi"; bind?: typeof bindOutboundVoiceRuntime; TerminalOwner?: typeof ClinikoOutboundTerminalOwner;
}) {
  const { engine, bind = bindOutboundVoiceRuntime, TerminalOwner = ClinikoOutboundTerminalOwner, ...rest } = options;
  const f = await outboundLaunchOwnerFixture(rest);
  try {
    f.controls.providerDigest = (engine === "abby" ? "b" : "c").repeat(64);
    const original = f.ports.provider;
    const state = { terminal: "terminal" as "terminal" | "unknown" | "active" };
    const adapter: OutboundVoiceRuntimeAdapter = { binding: original.binding.bind(original), launchOnce: original.launchOnce.bind(original),
      inspectTerminal: async identity => {
        if (state.terminal !== "terminal") return { kind: state.terminal };
        if (!f.calls.length || f.calls.some(c => c.effectRef !== identity.effectRef || c.capacityAllocationRef !== identity.capacityAllocationRef)) return { kind: "unknown" };
        return { kind: "terminal", complete: true, ...identity,
          provider: { ref: f.controls.providerRef, bindingDigest: f.controls.providerDigest }, endedAt: f.state.now, observedAt: f.state.now };
      } };
    const selected = value(bind(adapter)); Object.assign(f.ports, { provider: selected.launch });
    const owner = value(f.make());
    const attempt = () => {
      const row = f.contactControls.rows.find(r => (r.recall_type as { links: { self: string } }).links.self.endsWith("/62"));
      assert.ok(row); return { row, value: value(decodeOutboundLaunchAttempt(row.notes)) };
    };
    const inspect = async () => {
      const a = attempt();
      const terminal = value(TerminalOwner.create({ attempts: f.config.attempts, campaignRef: f.request.campaignRef,
        capacityScope: f.request.scope, maximumNativeRequests: 8, deadlineMs: 15000 }, {
        record: { allows: f.ports.attempt.allows, current: f.ports.attempt.current },
        authority: { allows: async () => true, current: () => true }, provider: selected.terminal, capacity: f.ports.capacity, native: f.native,
      }));
      return terminal.inspectAndRelease({ recallRef: `cliniko:recall:${a.row.id}`, actionRef: a.value.actionRef, patientId: a.value.patientId }, new AbortController().signal);
    };
    return { ...f, get claims() { return f.claims; }, get posts() { return f.posts; }, selected, adapter, runtimeState: state, attempt, inspect,
      launchSelected: () => owner.launchOnce(f.binding, new AbortController().signal) };
  } catch (e) { await f.close(); throw e; }
}
