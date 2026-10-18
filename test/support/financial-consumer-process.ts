import { serveClinikoVoice } from "../../scripts/serve-cliniko-voice.ts";
import { ClinikoFinancialResendRecords } from "../../src/cliniko/financial-resend-records.ts";
import type { FinancialResendRequest } from "../../src/cliniko/financial-resend-request.ts";
import type { ClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import type { FinancialCaseClassApproval } from "../../src/standalone/cliniko-financial-case-class-expiry.ts";
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
export type FinancialConsumerProcessSetup = Readonly<{ kind: "start"; now: string; voiceRunner?: true; advancingClock?: true; reviewDate?: string; resend?: Readonly<{ maximumAuthorityRequests: number }>; resendRequestRetention?: Readonly<{ request: FinancialResendRequest; intent: ClinikoFinancialIntent; reviewDate: string }>; supportsHeadroom?: boolean; enableCheckoutExpiry?: boolean; enableClinicalExpiry?: boolean; classClinicalExpiry?: FinancialConsumerClassExpirySetup; caseClassClinicalExpiry?: FinancialConsumerClassExpirySetup & Readonly<{ maximumAuthorityRequests: number }>; smtp: SmtpMailConfig;
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
  const began = performance.now();
  const clock = () => setup.advancingClock ? new Date(Date.parse(setup.now) + performance.now() - began).toISOString() : setup.now;
  const db = connectPostgres(process.env.DATABASE_URL!);
  try {
    const config: FinancialConsumerConfig = { ...setup.config, checkout: { ...setup.config.checkout,
      cliniko: { ...setup.config.checkout.cliniko, clock,
        producer: { keyRef: setup.config.checkout.cliniko.producer.keyRef, publicKey: createPublicKey(setup.config.checkout.cliniko.producer.pem) },
        rateBudget: { ...(setup.supportsHeadroom ? { checkHeadroom: (requests: number) => rpc("headroom", requests) as ReturnType<NonNullable<ClinikoRequestBudget["checkHeadroom"]>> } : {}), claim: () => rpc("claim", null) as ReturnType<ClinikoRequestBudget["claim"]>,
          observe429: reset => rpc("observe429", reset) as ReturnType<ClinikoRequestBudget["observe429"]> } },
      stripe: { ...setup.config.checkout.stripe, clock: () => Date.parse(clock()) } },
      webhook: { ...setup.config.webhook, clock: () => Date.parse(clock()) } };
    const binding = financialRecordOwnerBinding(config.checkout.cliniko); if (!binding.ok) throw new Error("Invalid synthetic owner");
    const barrier = new PostgresFinancialEffectBarrier(db, config.checkout.cliniko.scope, binding.value);
    const current = () => process.connected;
    if (setup.resendRequestRetention) {
      const records = ClinikoFinancialResendRecords.create(config.checkout.cliniko,
        { allows: q => grant("resendRecord", q), producerAdmitted: q => grant("producer", q), current }, barrier, port);
      if (!records.ok) throw new Error("Invalid synthetic resend recorder");
      process.send?.({ kind: "ready", port: 0 });
      const request = setup.resendRequestRetention;
      const retained = await records.value.retainRequestOnce(request.request, request.intent, request.reviewDate, new AbortController().signal);
      process.send?.({ kind: "resendRetained", data: retained }); return;
    }
    const capturedClass = setup.classClinicalExpiry ? await OwnerFileClassPolicy.capture({ ...setup.classClinicalExpiry.binding,
      path: setup.classClinicalExpiry.path, directory: new OwnerFileAdminDirectory(setup.classClinicalExpiry.directoryPath, setup.classClinicalExpiry.binding.scope),
      clock }) : undefined;
    if (capturedClass && !capturedClass.ok) throw new Error("Invalid synthetic class policy");
    const capturedCase = setup.caseClassClinicalExpiry ? await OwnerFileClassPolicy.capture({ ...setup.caseClassClinicalExpiry.binding,
      path: setup.caseClassClinicalExpiry.path, directory: new OwnerFileAdminDirectory(setup.caseClassClinicalExpiry.directoryPath, setup.caseClassClinicalExpiry.binding.scope),
      clock }) : undefined;
    if (capturedCase && !capturedCase.ok) throw new Error("Invalid synthetic case policy");
    const makeConsumer = (rateBudget?: ClinikoRequestBudget) => ClinikoFinancialConsumer.create(rateBudget ? { ...config, checkout: { ...config.checkout, cliniko: { ...config.checkout.cliniko, rateBudget } } } : config, {
      run: { allows: q => grant("run", q), current },
      pending: { allowsPendingRead: q => grant("pending", q), allowsRecordRead: q => grant("record", q), current },
      records: { allows: q => grant("record", q), producerAdmitted: q => grant("producer", q), current },
      checkout: { sourceAuthorized: q => grant("record", q), attemptScanAuthorized: q => grant("history", q),
        collectionAuthorized: q => grant("collection", q), producerAdmitted: q => grant("producer", q), current },
      message: { sourceAuthorized: q => grant("record", q), attemptScanAuthorized: q => grant("history", q),
        providerBindingAuthorized: q => grant("messageBinding", q), messageAuthorized: q => grant("message", q),
        producerAdmitted: q => grant("producer", q), current },
      ...(setup.resend ? { resend: { maximumAuthorityRequests: setup.resend.maximumAuthorityRequests, authority: {
        allows: q => grant("resendRequest", q), financialAuthorized: q => grant("resendFinancial", q), current,
      } } } : {}),
      ...(setup.enableCheckoutExpiry ? { checkoutExpiry: {
        sources: { allows: q => grant("record", q), allowsHistory: q => grant("history", q), current },
        referenceAuthorized: q => grant("expiryReference", q), providerBindingAuthorized: q => grant("providerBinding", q),
        expiryAuthorized: q => grant("checkoutExpiry", q), producerAdmitted: q => grant("producer", q), current,
      } } : {}),
      ...(capturedCase?.ok ? { caseClassClinicalExpiry: { classPolicy: capturedCase.value,
        maximumAuthorityRequests: setup.caseClassClinicalExpiry!.maximumAuthorityRequests, authority: {
          sources: { allows: q => grant("caseClassClinicalSource", q), allowsHistory: q => grant("caseClassClinicalHistory", q), current },
          referenceAuthorized: q => grant("caseClassClinicalReference", q), providerBindingAuthorized: q => grant("caseClassClinicalBinding", q),
          financialAuthorized: q => grant("caseClassClinicalFinancial", q), clinicalApproval: q => rpc("caseClassClinicalApproval", q) as Promise<FinancialCaseClassApproval | null>,
          producerAdmitted: q => grant("producer", q), current,
        } } } : {}),
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
      work: { authorizeWork: async q => await grant("work", q) ? { reviewDate: setup.reviewDate ?? "2026-11-02" } : null,
        providerBindingAuthorized: q => grant("providerBinding", q), current,
        onCheckoutAcknowledged: async receipt => { await rpc("acknowledged", receipt); } },
      webhook: { allowsReferenceRead: q => grant("webhookReference", q), acceptsExistingPending: q => grant("handoff", q), current },
    }, { barrier, delivery: new SmtpFinancialMessageDelivery(setup.smtp, "Australia/Sydney"), native: port, stripe: port,
      onCycle: cycle => process.send?.({ kind: "cycle", cycle }) });
    if (setup.voiceRunner) {
      if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || !config.checkout.cliniko.apiKey.startsWith("synthetic-"))
        throw new Error("Isolated synthetic owning runner required");
      for (const key of Object.keys(process.env)) if (key.startsWith("ABBY_") && key !== "ABBY_ISOLATED_POSTGRES_PROBE") delete process.env[key];
      Object.assign(process.env, {
        ABBY_VOICE_PORT: "0", ABBY_TENANT_ID: config.checkout.cliniko.scope.tenantId,
        ABBY_CLINIC_ID: config.checkout.cliniko.scope.clinicId, ABBY_LOCATION_ID: config.checkout.cliniko.scope.locationId,
        ABBY_CLINIKO_API_KEY: config.checkout.cliniko.apiKey, ABBY_CLINIKO_CONTACT_EMAIL: config.checkout.cliniko.contactEmail,
        ABBY_TWILIO_TEST_NUMBER: "+6125550199", ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188",
        ABBY_TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`, ABBY_TWILIO_AUTH_TOKEN: "synthetic-token",
        ABBY_TWILIO_PUBLIC_WEBHOOK_URL: "https://calls.example.test/twilio/inbound",
        ABBY_TWILIO_PUBLIC_STREAM_URL: "wss://calls.example.test/twilio/media/",
        ABBY_TWILIO_BINDING_KEY_HEX: "66".repeat(32), ABBY_VOICE_ROUTE_VERSION: "financial-chain-test-v1",
        ABBY_GREETING_VERSION: "test-v1", ABBY_GREETING_APPROVAL_OWNER_REF: "synthetic-owner",
        ABBY_GREETING_APPROVED_TEXT: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow.",
        ABBY_SEVEN_DAY_AVAILABILITY_ENABLED: "0", ABBY_OPENAI_API_KEY: "synthetic-openai", ABBY_OPENAI_INTENT_MODEL: "synthetic-model",
      });
      try {
        await serveClinikoVoice({ clinikoFetch: port,
          openaiFetch: async () => { throw new Error("No synthetic financial model configured"); },
          financialConsumer: context => {
            const consumer = makeConsumer(context.rateBudget);
            if (!consumer.ok) throw new Error("Synthetic financial host unavailable");
            return consumer.value;
          } });
      } finally { await db.destroy(); if (process.connected) process.disconnect(); }
      return;
    }
    const consumer = makeConsumer();
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
