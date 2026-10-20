import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { outboundContactSourceFixture } from "./outbound-contact-source.ts";
import { value } from "./outbound-records.ts";
import { contactSourceSelection } from "../../src/cliniko/outbound-contact-source.ts";
import { OwnerFileOutboundContactAccount } from "../../src/standalone/owner-file-outbound-contact-account.ts";
import type { OutboundContactAccountApproval } from "../../src/standalone/owner-file-outbound-contact-account.ts";
export async function outboundContactAccountFixture(options: { deadlineMs?: number; apiKey?: string; otherApiKey?: string; scope?: import("../../src/core/model.ts").LocationScope; Account?: typeof OwnerFileOutboundContactAccount } = {}) {
  const first = await outboundContactSourceFixture({ ...(options.apiKey ? { apiKey: options.apiKey } : {}), ...(options.scope ? { scope: options.scope } : {}) }); let second: Awaited<ReturnType<typeof outboundContactSourceFixture>> | undefined;
  try {
    second = await outboundContactSourceFixture({ apiKey: options.otherApiKey ?? first.config.apiKey, scope: { ...first.request.scope, locationId: "second-location" } });
    const path = join(dirname(first.definitionConfig.path), "account.json"), { source: _source, ...common } = first.approval;
    const sources = [first, second].map(f => contactSourceSelection(f.config));
    const approval: OutboundContactAccountApproval = { ...common, revision: "complete-contact-account-1", account: { ref: "clinic-native-account",
      coverage: "allCurrentAndRetiredVoiceContactSources", credentialFingerprints: [...new Set(sources.map(s => s.credentialFingerprint))], sources } };
    await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
    const config = { path, scope: first.request.scope, credentialFingerprint: first.request.credentialFingerprint, directory: first.directory,
      definitions: [first, second].map((f, i) => ({ selection: sources[i]!, definition: f.definition })), clock: () => first.state.now,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }) };
    const make = (signal = new AbortController().signal) => (options.Account ?? OwnerFileOutboundContactAccount).capture(config, signal), owner = value(await make());
    return { first, second, approval, config, owner, make, read: (signal = new AbortController().signal) => owner.current(signal),
      replace: (patch: Record<string, unknown>) => writeFile(path, JSON.stringify({ ...approval, ...patch }), { mode: 0o600 }),
      close: () => Promise.all([first.close(), second!.close()]) };
  } catch (error) { await first.close(); await second?.close(); throw error; }
}
