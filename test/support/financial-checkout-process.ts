/** Synthetic process-loss qualification worker. Private context travels through
 * IPC/provider ports only; never a local retry file or production endpoint. */
import { createPublicKey } from "node:crypto";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { ClinikoStripeCheckoutOwner } from "../../src/standalone/cliniko-stripe-checkout.ts";
import type { CheckoutOwnerConfig, CheckoutOwnerBinding } from "../../src/standalone/cliniko-stripe-checkout.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";

type Setup = { kind: "start"; config: Omit<CheckoutOwnerConfig, "cliniko" | "stripe"> & {
  cliniko: Omit<CheckoutOwnerConfig["cliniko"], "producer" | "rateBudget" | "clock"> & { producer: { keyRef: string; pem: string } };
  stripe: Omit<CheckoutOwnerConfig["stripe"], "clock">;
}; binding: CheckoutOwnerBinding; now: string };
let id = 0;
const replies = new Map<number, (v: unknown) => void>();
function rpc(kind: string, data: unknown): Promise<unknown> {
  const requestId = ++id;
  return new Promise(resolve => { replies.set(requestId, resolve); process.send?.({ kind, id: requestId, data }); });
}
const port: typeof fetch = async (input, init) => {
  const raw = await rpc("fetch", { input: String(input), method: init?.method, body: init?.body, headers: Object.fromEntries(new Headers(init?.headers)) }) as { body: string; status: number };
  return new Response(raw.body, { status: raw.status });
};
process.on("message", async (message: unknown) => {
  if (message !== null && typeof message === "object" && "kind" in message && message.kind === "reply" &&
      "id" in message && typeof message.id === "number" && "data" in message) {
    replies.get(message.id)?.(message.data); replies.delete(message.id); return;
  }
  const setup = message as Setup;
  if (setup?.kind !== "start") return;
  const db = connectPostgres(process.env.DATABASE_URL!);
  try {
    const config: CheckoutOwnerConfig = { ...setup.config, cliniko: { ...setup.config.cliniko,
      producer: { keyRef: setup.config.cliniko.producer.keyRef, publicKey: createPublicKey(setup.config.cliniko.producer.pem) },
      clock: () => setup.now, rateBudget: { claim: () => rpc("claim", {}) as ReturnType<ClinikoRequestBudget["claim"]>,
        observe429: reset => rpc("observe429", reset) as ReturnType<ClinikoRequestBudget["observe429"]> } },
      stripe: { ...setup.config.stripe, clock: () => Date.parse(setup.now) } };
    const binding = financialRecordOwnerBinding(config.cliniko); if (!binding.ok) throw new Error("Invalid binding");
    const barrier = new PostgresFinancialEffectBarrier(db, config.cliniko.scope, binding.value);
    const owner = ClinikoStripeCheckoutOwner.create(config, { sourceAuthorized: async () => true, attemptScanAuthorized: async () => true,
      collectionAuthorized: async () => true, producerAdmitted: async () => true, current: () => true },
      { allows: async () => true, producerAdmitted: async () => true, current: () => true }, barrier, port, port);
    if (!owner.ok) throw new Error("Owner unavailable");
    const result = await owner.value.createOnce(setup.binding, new AbortController().signal);
    process.send?.({ kind: "result", result });
  } catch { process.send?.({ kind: "workerError" }); }
  finally { await db.destroy(); process.disconnect?.(); }
});
