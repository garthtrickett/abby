import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { contactSourceBinding, contactSourceSelection } from "../../src/cliniko/internal/outbound-contact-source-context.ts";
import { OwnerFileOutboundDncPolicy } from "../../src/standalone/owner-file-outbound-dnc-policy.ts";
import type { OutboundDncPolicyApproval, OutboundDncPolicySelection } from "../../src/standalone/owner-file-outbound-dnc-policy.ts";
import type { AdminDirectory } from "../../src/standalone/identity/magic-link.ts";
import { outboundContactSourceFixture } from "./outbound-contact-source.ts";

export async function outboundDncPolicyFixture() {
  const f = await outboundContactSourceFixture(), path = join(dirname(f.definitionConfig.path), "automatic-dnc.json");
  const selection: OutboundDncPolicySelection = { scope: f.config.scope, sourceBinding: contactSourceBinding(contactSourceSelection(f.config)),
    automationPrincipalRef: "clinic-approved-optout-automation", provider: { ref: "clinic-voice-provider", bindingDigest: "b".repeat(64) } };
  const { source: _source, ...common } = f.approval;
  const approval: OutboundDncPolicyApproval = { ...common, revision: "automatic-dnc-v1", dnc: {
    sourceBinding: selection.sourceBinding, automationPrincipalRef: selection.automationPrincipalRef, provider: selection.provider,
    participant: "anyAtDialledNumber", consent: "unknown", doNotCall: "blocked", reconsent: "clinicApprovalOnly" } };
  await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
  const controls: { lookups: number; beforeLookup?: () => void | Promise<void>; readClock?: () => string } = { lookups: 0 };
  const directory: AdminDirectory = { findByRef: async (...args) => { controls.lookups++; await controls.beforeLookup?.(); return f.directory.findByRef(...args); },
    findByEmail: f.directory.findByEmail.bind(f.directory) };
  const config = { path, scope: f.config.scope, directory, clock: () => controls.readClock?.() ?? f.state.now, deadlineMs: 15000 };
  return { ...f, policyPath: path, selection, policyApproval: approval, policyControls: controls, policyConfig: config,
    replacePolicy: (patch: Record<string, unknown>) => writeFile(path, JSON.stringify({ ...approval, ...patch })),
    capturePolicy: (signal = new AbortController().signal) => OwnerFileOutboundDncPolicy.capture(config, signal) };
}
