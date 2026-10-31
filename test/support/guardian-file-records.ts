import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { inheritClinikoRequestCost } from "../../src/cliniko/request-cost.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { ownerFileGuardianRecords } from "../../src/standalone/owner-file-guardian-records.ts";
import { guardianCallOwnerFixture } from "./guardian-call-owner.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

/** Real owner-file ports over the existing synthetic native guardian fixture. */
export async function guardianFileRecordFixture(options: Parameters<typeof guardianCallOwnerFixture>[0] = {}) {
  const original = await guardianCallOwnerFixture(options);
  let flow: ClinikoCallFlow | undefined;
  try {
    const context = original.config.context;
    const binding = { scope: context.receipt.scope, policyVersion: context.policyVersion, businessId: "11",
      credentialFingerprint: clinikoCredentialFingerprint(context.cliniko.apiKey) };
    const identityPath = join(original.base.f.folder, "guardian-identities.json"), authorityPath = join(original.base.f.folder, "guardian-authorities.json");
    assert.ok(original.state.identity && original.state.authority && context.inbound.presentedCallerNumber && context.cliniko.rateBudget);
    const identityDocument = { schemaVersion: 1, kind: "guardianIdentities", ...binding,
      entries: [{ normalizedPhone: context.inbound.presentedCallerNumber, record: original.state.identity }] };
    const authorityDocument = { schemaVersion: 1, kind: "guardianAuthorities", ...binding,
      entries: [{ identity: original.base.r.identity, record: original.state.authority }] };
    const writeIdentities = (value: unknown = identityDocument) => writeFile(identityPath, JSON.stringify(value), { mode: 0o600 });
    const writeAuthorities = (value: unknown = authorityDocument) => writeFile(authorityPath, JSON.stringify(value), { mode: 0o600 });
    await writeIdentities(); await writeAuthorities();
    const sourceConfig = { ...binding, identityPath, authorityPath, budget: context.cliniko.rateBudget };
    const sources = ownerFileGuardianRecords(sourceConfig);
    const provision = { approvalPath: original.provision.approvalPath,
      identities: { read: inheritClinikoRequestCost(async (query: Parameters<typeof sources.identities.read>[0]) => { original.counts.identities++; return sources.identities.read(query); }, sources.identities.read) },
      authorities: { read: inheritClinikoRequestCost(async (query: Parameters<typeof sources.authorities.read>[0]) => { original.counts.authorities++; return sources.authorities.read(query); }, sources.authorities.read) } };
    const input = { ...original.input, guardian: provision };
    original.flow.dispose();
    const flowConfig = { ...original.flowConfig, representativeInput: input };
    flow = resultValue(ClinikoCallFlow.create(flowConfig));
    const current = flow;
    return { ...original, flow: current, flowConfig, input, provision, sources, sourceConfig, binding, identityPath, authorityPath,
      identityDocument, authorityDocument, writeIdentities, writeAuthorities, config: { ...original.config, flow: current, ...input },
      close: async () => { current.dispose(); await original.close(); } };
  } catch (error) { flow?.dispose(); await original.close(); throw error; }
}
