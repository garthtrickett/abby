/** One compiled synthetic read. Private IPC only, no database connection,
 * producer, writable journal, provider write, listener or patient payload file. */
import { ClinikoOutboundContactSource } from "../../src/cliniko/outbound-contact-source.ts";
import type { OutboundContactSourceConfig, OutboundContactQuery } from "../../src/cliniko/outbound-contact-source.ts";
import { OwnerFileOutboundContactSource } from "../../src/standalone/owner-file-outbound-contact-source.ts";
import type { AdminDirectory } from "../../src/standalone/identity/magic-link.ts";
import type { OutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoContactRevisionReader } from "../../src/cliniko/contact-revision.ts";
export type ContactProcessSetup = Readonly<{ kind: "start"; sourcePath: string; now: string; request: OutboundRecipientRequest;
  config: Omit<OutboundContactSourceConfig, "clock" | "rateBudget" | "contactRevision"> }>;
let sequence = 0, started = false;
const replies = new Map<number, (data: unknown) => void>();
const rpc = (kind: string, data: unknown): Promise<unknown> => new Promise(resolve => {
  const id = ++sequence; replies.set(id, resolve); process.send?.({ kind, id, data });
});
process.on("message", async (raw: unknown) => {
  const message = raw as { kind: string; id: number; data: unknown };
  if (message?.kind === "reply") { replies.get(message.id)?.(message.data); replies.delete(message.id); return; }
  const setup = raw as ContactProcessSetup; if (setup?.kind !== "start" || started) return; started = true;
  try {
    const directory: AdminDirectory = { findByRef: ref => rpc("membership", ref) as ReturnType<AdminDirectory["findByRef"]>,
      findByEmail: email => rpc("emailMembership", email) as ReturnType<AdminDirectory["findByEmail"]> };
    const signal = new AbortController().signal;
    const definition = await OwnerFileOutboundContactSource.capture({ path: setup.sourcePath, scope: setup.config.scope, directory, clock: () => setup.now }, signal);
    if (!definition.ok) { process.send?.({ kind: "result", data: definition }); return; }
    const config: OutboundContactSourceConfig = { ...setup.config, clock: () => setup.now,
      rateBudget: { claim: () => rpc("claim", null) as ReturnType<ClinikoRequestBudget["claim"]>,
        observe429: reset => rpc("observe429", reset) as ReturnType<ClinikoRequestBudget["observe429"]> },
      contactRevision: { matches: (tenant, credential) => tenant === setup.request.scope.tenantId && credential === setup.request.credentialFingerprint,
        read: credential => rpc("revision", credential) as ReturnType<ClinikoContactRevisionReader["read"]> } };
    const port: typeof fetch = async (input, init) => {
      const found = await rpc("fetch", { input: String(input), method: init?.method, body: init?.body, headers: Object.fromEntries(new Headers(init?.headers)) }) as { failed?: boolean; status: number; body: string };
      if (found.failed) throw new Error("Synthetic native read unavailable"); return new Response([204, 205, 304].includes(found.status) ? null : found.body, { status: found.status });
    };
    const source = ClinikoOutboundContactSource.create(config, definition.value, { allows: async (query: OutboundContactQuery) => await rpc("grant", query) === true,
      current: () => process.connected }, port);
    if (!source.ok) { process.send?.({ kind: "result", data: source }); return; }
    process.send?.({ kind: "result", data: await source.value.readCurrentForRequest(setup.request, signal) });
  } catch { process.send?.({ kind: "workerError" }); }
  finally { if (process.connected) process.disconnect(); }
});
