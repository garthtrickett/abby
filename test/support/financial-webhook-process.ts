/** Synthetic worker only. The fixture provider survives this process; financial
 * records and raw event bytes arrive through IPC, never a local retry file. */
import { createPublicKey } from "node:crypto";
import { ClinikoStripeWebhookHandoff } from "../../src/standalone/cliniko-stripe-webhook-handoff.ts";
import type { FinancialWebhookHandoffConfig } from "../../src/standalone/cliniko-stripe-webhook-handoff.ts";
import { ClinikoFinancialPendingDiscovery } from "../../src/cliniko/financial-pending-discovery.ts";
type Setup = { kind: "start"; mode: "accept" | "rediscover"; now: string; raw: string; signature: string;
  config: { cliniko: Omit<FinancialWebhookHandoffConfig["cliniko"], "producer" | "rateBudget" | "clock"> & { producer: { keyRef: string; pem: string } };
    stripe: Omit<FinancialWebhookHandoffConfig["stripe"], "clock">; webhook: Omit<FinancialWebhookHandoffConfig["webhook"], "clock"> } };
let id = 0;
const replies = new Map<number, (data: { body: string; status: number }) => void>();
const port: typeof fetch = async (input, init) => {
  const requestId = ++id;
  const response = await new Promise<{ body: string; status: number }>(resolve => {
    replies.set(requestId, resolve);
    process.send?.({ kind: "fetch", id: requestId, input: String(input), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)) });
  });
  return new Response(response.body, { status: response.status });
};
process.on("message", async (raw: unknown) => {
  const reply = raw as { kind: string; id: number; data: { body: string; status: number } };
  if (reply?.kind === "reply") { replies.get(reply.id)?.(reply.data); replies.delete(reply.id); return; }
  const setup = raw as Setup;
  if (setup?.kind !== "start") return;
  try {
    const config: FinancialWebhookHandoffConfig = { cliniko: { ...setup.config.cliniko,
      producer: { keyRef: setup.config.cliniko.producer.keyRef, publicKey: createPublicKey(setup.config.cliniko.producer.pem) },
      clock: () => setup.now, rateBudget: { claim: async () => null, observe429: async () => ({ kind: "rateLimited" }) } },
      stripe: { ...setup.config.stripe, clock: () => Date.parse(setup.now) }, webhook: { ...setup.config.webhook, clock: () => Date.parse(setup.now) } };
    const pendingAuthority = { allowsPendingRead: async () => true, allowsRecordRead: async () => true, current: () => true };
    if (setup.mode === "rediscover") {
      const reader = ClinikoFinancialPendingDiscovery.create(config.cliniko, pendingAuthority, port);
      if (!reader.ok) throw new Error("Synthetic worker unavailable");
      const found = await reader.value.scanPending(new AbortController().signal);
      process.send?.({ kind: "result", result: found.ok ? { work: found.value.work.length, attempts: found.value.attempts.length,
        paired: found.value.work.filter(w => w.kind === "pairedContext").length } : { unavailable: true } });
    } else {
      const handoff = ClinikoStripeWebhookHandoff.create(config, { allowsReferenceRead: async () => true,
        acceptsExistingPending: async () => true, current: () => true }, pendingAuthority, port, port);
      if (!handoff.ok) throw new Error("Synthetic worker unavailable");
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(setup.raw)); c.close(); } });
      process.send?.({ kind: "result", result: await handoff.value.accept(body, setup.signature, new AbortController().signal) });
    }
    // Remain alive until the parent kills or explicitly disconnects this worker.
  } catch { process.send?.({ kind: "workerError" }); }
});
