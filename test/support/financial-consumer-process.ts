/** Compiled synthetic host. Private provider/approval traffic uses IPC; only a
 * loopback raw webhook listener and fixed cycle counts are exposed. No retry
 * file or private local queue exists. The provider/financial owner outlives us. */
import { createPublicKey } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { OwnerFileClassPolicy } from "../../src/standalone/owner-file-class-policy.ts";
import type { ClassPolicyBinding } from "../../src/standalone/owner-file-class-policy.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import type { FinancialUnlinkedClassApproval } from "../../src/standalone/cliniko-financial-unlinked-class-expiry.ts";
import { ClinikoFinancialConsumer } from "../../src/standalone/cliniko-financial-consumer.ts";
import type { FinancialClinicalApproval } from "../../src/standalone/cliniko-financial-clinical-expiry.ts";
import type { FinancialConsumerConfig } from "../../src/standalone/cliniko-financial-consumer.ts";
import { SmtpFinancialMessageDelivery } from "../../src/standalone/smtp-financial-message-delivery.ts";
import type { SmtpMailConfig } from "../../src/standalone/smtp-text-mail-transport.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";

export type FinancialConsumerClassExpirySetup = Readonly<{ path: string; directoryPath: string; binding: ClassPolicyBinding }>;
export type FinancialConsumerProcessSetup = Readonly<{ kind: "start"; now: string; enableCheckoutExpiry?: boolean; enableClinicalExpiry?: boolean; classClinicalExpiry?: FinancialConsumerClassExpirySetup; smtp: SmtpMailConfig;
  config: Omit<FinancialConsumerConfig, "checkout" | "webhook"> & {
    checkout: Omit<FinancialConsumerConfig["checkout"], "cliniko" | "stripe"> & {
      cliniko: Omit<FinancialConsumerConfig["checkout"]["cliniko"], "producer" | "rateBudget" | "clock"> & { producer: { keyRef: string; pem: string } };
      stripe: Omit<FinancialConsumerConfig["checkout"]["stripe"], "clock">;
    }; webhook: Omit<FinancialConsumerConfig["webhook"], "clock">;
  };
}>;
let id = 0, started = false;
const replies = new Map<number, (value: unknown) => void>();
const rpc = (kind: string, data: unknown): Promise<unknown> => new Promise(resolve => {
  const requestId = ++id; replies.set(requestId, resolve); process.send?.({ kind, id: requestId, data });
});
const port: typeof fetch = async (input, init) => {
  const response = await rpc("fetch", { input: String(input), method: init?.method, body: init?.body,
    headers: Object.fromEntries(new Headers(init?.headers)) }) as { body: string; status: number };
  return new Response([204, 205, 304].includes(response.status) ? null : response.body, { status: response.status });
};
const grant = async (purpose: string, query: unknown) => await rpc("grant", { purpose, query }) === true;
process.on("message", async (raw: unknown) => {
  const reply = raw as { kind: string; id: number; data: unknown };
  if (reply?.kind === "reply") { replies.get(reply.id)?.(reply.data); replies.delete(reply.id); return; }
  const setup = raw as FinancialConsumerProcessSetup;
  if (setup?.kind !== "start" || started) return; started = true;
  const db = connectPostgres(process.env.DATABASE_URL!);
  try {
    const config: FinancialConsumerConfig = { ...setup.config, checkout: { ...setup.config.checkout,
      cliniko: { ...setup.config.checkout.cliniko, clock: () => setup.now,
        producer: { keyRef: setup.config.checkout.cliniko.producer.keyRef, publicKey: createPublicKey(setup.config.checkout.cliniko.producer.pem) },
        rateBudget: { claim: () => rpc("claim", null) as ReturnType<ClinikoRequestBudget["claim"]>,
          observe429: reset => rpc("observe429", reset) as ReturnType<ClinikoRequestBudget["observe429"]> } },
      stripe: { ...setup.config.checkout.stripe, clock: () => Date.parse(setup.now) } },
      webhook: { ...setup.config.webhook, clock: () => Date.parse(setup.now) } };
    const binding = financialRecordOwnerBinding(config.checkout.cliniko); if (!binding.ok) throw new Error("Invalid synthetic owner");
    const barrier = new PostgresFinancialEffectBarrier(db, config.checkout.cliniko.scope, binding.value);
    const current = () => process.connected;
    const capturedClass = setup.classClinicalExpiry ? await OwnerFileClassPolicy.capture({ ...setup.classClinicalExpiry.binding,
      path: setup.classClinicalExpiry.path, directory: new OwnerFileAdminDirectory(setup.classClinicalExpiry.directoryPath, setup.classClinicalExpiry.binding.scope),
      clock: () => setup.now }) : undefined;
    if (capturedClass && !capturedClass.ok) throw new Error("Invalid synthetic class policy");
    const consumer = ClinikoFinancialConsumer.create(config, {
      run: { allows: q => grant("run", q), current },
      pending: { allowsPendingRead: q => grant("pending", q), allowsRecordRead: q => grant("record", q), current },
      records: { allows: q => grant("record", q), producerAdmitted: q => grant("producer", q), current },
      checkout: { sourceAuthorized: q => grant("record", q), attemptScanAuthorized: q => grant("history", q),
        collectionAuthorized: q => grant("collection", q), producerAdmitted: q => grant("producer", q), current },
      message: { sourceAuthorized: q => grant("record", q), attemptScanAuthorized: q => grant("history", q),
        providerBindingAuthorized: q => grant("messageBinding", q), messageAuthorized: q => grant("message", q),
        producerAdmitted: q => grant("producer", q), current },
      ...(setup.enableCheckoutExpiry ? { checkoutExpiry: {
        sources: { allows: q => grant("record", q), allowsHistory: q => grant("history", q), current },
        referenceAuthorized: q => grant("expiryReference", q), providerBindingAuthorized: q => grant("providerBinding", q),
        expiryAuthorized: q => grant("checkoutExpiry", q), producerAdmitted: q => grant("producer", q), current,
      } } : {}),
      ...(capturedClass?.ok ? { classClinicalExpiry: { classPolicy: capturedClass.value, authority: {
        sources: { allows: q => grant("classClinicalSource", q), allowsHistory: q => grant("classClinicalHistory", q), current },
        referenceAuthorized: q => grant("classClinicalReference", q), providerBindingAuthorized: q => grant("classClinicalBinding", q),
        financialAuthorized: q => grant("classClinicalFinancial", q), clinicalApproval: q => rpc("classClinicalApproval", q) as Promise<FinancialUnlinkedClassApproval | null>,
        producerAdmitted: q => grant("producer", q), current,
      } } } : {}),
      ...(setup.enableClinicalExpiry ? { clinicalExpiry: {
        sources: { allows: q => grant("clinicalSource", q), allowsHistory: q => grant("clinicalHistory", q), current },
        referenceAuthorized: q => grant("clinicalReference", q), providerBindingAuthorized: q => grant("clinicalBinding", q),
        financialAuthorized: q => grant("clinicalFinancial", q), clinicalApproval: async q => await rpc("clinicalApproval", q) as FinancialClinicalApproval | null,
        producerAdmitted: q => grant("producer", q), current,
      } } : {}),
      work: { authorizeWork: async q => await grant("work", q) ? { reviewDate: "2026-11-02" } : null,
        providerBindingAuthorized: q => grant("providerBinding", q), current,
        onCheckoutAcknowledged: async receipt => { await rpc("acknowledged", receipt); } },
      webhook: { allowsReferenceRead: q => grant("webhookReference", q), acceptsExistingPending: q => grant("handoff", q), current },
    }, { barrier, delivery: new SmtpFinancialMessageDelivery(setup.smtp, "Australia/Sydney"), native: port, stripe: port,
      onCycle: cycle => process.send?.({ kind: "cycle", cycle }) });
    if (!consumer.ok) throw new Error("Synthetic financial host unavailable");
    const server = createServer(consumer.value.handle); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic listener unavailable");
    const running = consumer.value.start(new AbortController().signal); if (!running.ok) throw new Error("Synthetic consumer unavailable");
    process.send?.({ kind: "ready", port: address.port });
    process.once("disconnect", () => {
      void consumer.value.close().then(() => new Promise<void>(resolve => server.close(() => resolve()))).finally(() => db.destroy());
    });
  } catch { await db.destroy(); process.send?.({ kind: "workerError" }); process.disconnect?.(); }
});
