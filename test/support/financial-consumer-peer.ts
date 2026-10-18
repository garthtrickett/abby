import { FinancialExpiryObservations } from "./financial-expiry-observation.ts";
import { existsSync } from "node:fs";
import type { FinancialResendQuery } from "../../src/standalone/cliniko-financial-resend-owner.ts";
import type { Result } from "../../src/core/model.ts";
import type { FinancialRecordRetention, FinancialRecordFailure } from "../../src/cliniko/financial-record-retention.ts";
import type { FinancialCaseClassExpiryQuery, FinancialCaseClassApproval } from "../../src/standalone/cliniko-financial-case-class-expiry.ts";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { FinancialClinicalApproval, FinancialClinicalExpiryQuery } from "../../src/standalone/cliniko-financial-clinical-expiry.ts";
import type { FinancialConsumerConfig, FinancialConsumerCycle } from "../../src/standalone/cliniko-financial-consumer.ts";
import type { ClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import type { CheckoutCreationReceipt } from "../../src/standalone/cliniko-stripe-checkout.ts";
import type { SmtpMailConfig } from "../../src/standalone/smtp-text-mail-transport.ts";
import type { FinancialUnlinkedClassExpiryQuery, FinancialUnlinkedClassApproval } from "../../src/standalone/cliniko-financial-unlinked-class-expiry.ts";
import type { FinancialConsumerClassExpirySetup, FinancialConsumerProcessSetup } from "./financial-consumer-process.ts";
import { now } from "./financial-retention.ts";

export type FinancialConsumerPeerFixture = Readonly<{ config: FinancialConsumerConfig; intent: ClinikoFinancialIntent;
  dependencies: Readonly<{ native: typeof fetch; stripe: typeof fetch }>; approved: Set<string>; receipts: CheckoutCreationReceipt[] }>;
export type FinancialConsumerPeerOptions = Readonly<{ now?: string; connectionString?: string; voiceRunner?: true; advancingClock?: true; reviewDate?: string; enableCheckoutExpiry?: boolean; enableClinicalExpiry?: boolean; producerAdmitted?(): boolean;
  allows?(purpose: string, query: unknown): boolean; holdExpiryReply?: boolean; onExpirySubmitted?(): void;
  resend?: FinancialConsumerProcessSetup["resend"];
  resendAuthorized?(query: FinancialResendQuery): boolean | Promise<boolean>;
  resendFinancialAuthorized?(query: FinancialResendQuery): boolean | Promise<boolean>;
  resendRequestRetention?: FinancialConsumerProcessSetup["resendRequestRetention"];
  holdResendRequestReply?: boolean; onResendRequestSubmitted?(): void;
  holdResendAttemptReply?: boolean; onResendAttemptSubmitted?(): void;
  classClinicalExpiry?: FinancialConsumerClassExpirySetup;
  caseClassClinicalExpiry?: FinancialConsumerClassExpirySetup & Readonly<{ maximumAuthorityRequests: number }>;
  caseClassClinicalApproval?(query: FinancialCaseClassExpiryQuery): FinancialCaseClassApproval | null | Promise<FinancialCaseClassApproval | null>;
  classClinicalApproval?(query: FinancialUnlinkedClassExpiryQuery): FinancialUnlinkedClassApproval | null | Promise<FinancialUnlinkedClassApproval | null>;
  observeExpiry?: true;
  clinicalApproval?(query: FinancialClinicalExpiryQuery): FinancialClinicalApproval | null | Promise<FinancialClinicalApproval | null>;
  holdClinicalReply?: boolean; onClinicalSubmitted?(): void }>;
/** A bounded observation wait is not proof that the outliving worker stopped. */
export class FinancialConsumerCycleWaitTimeout extends Error {}
/** Actual compiled host with outliving independently authorized fixture providers.
 * Private RPC payloads stay in volatile fixture memory, never operational logs or
 * a local retry file. Consumers receive only native discovery, not selected refs. */
export async function financialConsumerPeer(f: FinancialConsumerPeerFixture, smtp: SmtpMailConfig, directory: string, options: FinancialConsumerPeerOptions = {}) {
  if (options.observeExpiry && (!options.voiceRunner || !options.connectionString)) throw new Error("Expiry observations require the actual SQL voice fixture");
  const entry = new URL(import.meta.url.endsWith(".js") ? "./financial-consumer-process.js" : "../../dist/runtime/test/support/financial-consumer-process.js", import.meta.url);
  assert.equal(existsSync(entry), true, "emitted financial worker required");
  const observer = new URL("./financial-expiry-process-observer.js", entry);
  if (options.observeExpiry) assert.equal(existsSync(observer), true, "emitted expiry observer required");
  const child = fork(entry, [], {
    ...(options.observeExpiry ? { execArgv: [...process.execArgv, "--import", observer.href] } : {}),
    cwd: directory, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, ...(options.connectionString ? { DATABASE_URL: options.connectionString } : {}), NODE_OPTIONS: "--max-old-space-size=256" } });
  const terminal = new Promise<NodeJS.Signals | null>(resolve => child.once("exit", (_code, signal) => resolve(signal)));
  const counts: FinancialConsumerCycle[] = [], output: string[] = [];
  const expiryObservations = new FinancialExpiryObservations();
  child.stdout?.on("data", data => output.push(String(data))); child.stderr?.on("data", data => output.push(String(data)));
  let waiting: { resolve(c: FinancialConsumerCycle): void; reject(e: Error): void } | undefined;
  let resolveReady!: (port: number) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  type Retention = Result<FinancialRecordRetention, FinancialRecordFailure>;
  let retention: Retention | undefined, waitingRetention: { resolve(value: Retention): void; reject(error: Error): void } | undefined;
  const fail = (error: Error) => { rejectReady(error); waiting?.reject(error); waitingRetention?.reject(error); };
  child.once("error", fail); child.once("exit", () => fail(new Error("Synthetic consumer process terminal")));
  child.on("message", async (raw: unknown) => {
    const m = raw as { kind: string; id: number; port: number; cycle: FinancialConsumerCycle; data: unknown };
    try {
      if (m.kind === "expiryObservation") {
        if (!options.observeExpiry || !expiryObservations.accept(raw)) throw new Error("Invalid expiry observation");
        return;
      }
      if (m.kind === (options.voiceRunner ? "listenerReady" : "ready")) { resolveReady(m.port); return; }
      if (m.kind === "resendRetained") { const next = waitingRetention; waitingRetention = undefined; if (next) next.resolve(m.data as Retention); else retention = m.data as Retention; return; }
      if (m.kind === "cycle") {
        if (waiting) { const next = waiting; waiting = undefined; next.resolve(m.cycle); } else counts.push(m.cycle); return;
      }
      if (m.kind === "workerError") throw new Error("Synthetic compiled consumer unavailable");
      let data: unknown;
      if (m.kind === "fetch") {
        const request = m.data as { input: string; method: string; body?: string; headers: Record<string, string> };
        const response = await (request.input.startsWith("https://api.stripe.com/") ? f.dependencies.stripe : f.dependencies.native)(request.input,
          { method: request.method, redirect: "error", headers: request.headers, signal: AbortSignal.timeout(30_000), ...(request.body === undefined ? {} : { body: request.body }) });
        if (options.holdExpiryReply && request.method === "POST" && request.input.endsWith("/expire")) { options.onExpirySubmitted?.(); return; }
        if (options.holdClinicalReply && request.method === "PATCH" && /\/(?:individual_appointments|attendees)\/[1-9][0-9]*\/cancel$/.test(request.input)) { options.onClinicalSubmitted?.(); return; }
        if (options.holdResendAttemptReply && request.method === "POST" && request.input.endsWith("/v1/recalls") &&
            String(request.body).includes("Abby financial resend attempt v1")) { options.onResendAttemptSubmitted?.(); return; }
        if (options.holdResendRequestReply && request.method === "POST" && request.input.endsWith("/v1/recalls") &&
            String(request.body).includes("Abby financial resend request v1")) { options.onResendRequestSubmitted?.(); return; }
        data = { body: await response.text(), status: response.status };
      } else if (m.kind === "grant") {
        const grant = m.data as { purpose: string; query: { checkoutRef?: string; binding?: { checkoutRef: string } } };
        data = grant.purpose === "resendRequest" ? (options.allows?.(grant.purpose, grant.query) ?? true) && await options.resendAuthorized?.(grant.query as FinancialResendQuery) === true
          : grant.purpose === "resendFinancial" ? (options.allows?.(grant.purpose, grant.query) ?? true) && await options.resendFinancialAuthorized?.(grant.query as FinancialResendQuery) === true
          : grant.purpose === "producer" ? (options.producerAdmitted?.() ?? true) : grant.purpose === "providerBinding" || grant.purpose === "messageBinding" || grant.purpose === "clinicalBinding" || grant.purpose === "classClinicalBinding" || grant.purpose === "caseClassClinicalBinding"
          ? f.approved.has(grant.query.checkoutRef ?? grant.query.binding?.checkoutRef ?? "") : options.allows?.(grant.purpose, grant.query) ?? true;
      } else if (m.kind === "clinicalApproval") data = await options.clinicalApproval?.(m.data as FinancialClinicalExpiryQuery) ?? null;
      else if (m.kind === "classClinicalApproval") data = await options.classClinicalApproval?.(m.data as FinancialUnlinkedClassExpiryQuery) ?? null;
      else if (m.kind === "caseClassClinicalApproval") data = await options.caseClassClinicalApproval?.(m.data as FinancialCaseClassExpiryQuery) ?? null;
      else if (m.kind === "headroom") data = f.config.checkout.cliniko.rateBudget.checkHeadroom ? await f.config.checkout.cliniko.rateBudget.checkHeadroom(Number(m.data)) : { kind: "unavailable" };
      else if (m.kind === "claim") data = await f.config.checkout.cliniko.rateBudget.claim();
      else if (m.kind === "observe429") data = await f.config.checkout.cliniko.rateBudget.observe429(null);
      else if (m.kind === "acknowledged") { const receipt = m.data as CheckoutCreationReceipt; f.receipts.push(receipt); f.approved.add(receipt.checkoutRef); data = true; }
      else throw new Error("Unexpected synthetic consumer operation");
      if (child.connected) child.send({ kind: "reply", id: m.id, data });
    } catch { fail(new Error("Synthetic provider or grant failed")); }
  });
  const { producer, rateBudget: _budget, clock: _nativeClock, ...cliniko } = f.config.checkout.cliniko;
  const { clock: _stripeClock, ...stripe } = f.config.checkout.stripe, { clock: _webhookClock, ...webhook } = f.config.webhook;
  const start: FinancialConsumerProcessSetup = { kind: "start", ...(options.voiceRunner ? { voiceRunner: true } : {}), ...(options.advancingClock ? { advancingClock: true } : {}), ...(options.reviewDate ? { reviewDate: options.reviewDate } : {}), ...(options.resend ? { resend: options.resend } : {}), ...(options.resendRequestRetention ? { resendRequestRetention: options.resendRequestRetention } : {}), now: options.now ?? now, ...(f.config.checkout.cliniko.rateBudget.checkHeadroom ? { supportsHeadroom: true } : {}), ...(options.enableCheckoutExpiry ? { enableCheckoutExpiry: true } : {}), ...(options.enableClinicalExpiry ? { enableClinicalExpiry: true } : {}), ...(options.classClinicalExpiry ? { classClinicalExpiry: options.classClinicalExpiry } : {}), ...(options.caseClassClinicalExpiry ? { caseClassClinicalExpiry: options.caseClassClinicalExpiry } : {}), smtp: { ...smtp, ...(smtp.ca ? { ca: Buffer.from(smtp.ca).toString() } : {}) },
    config: { ...f.config, checkout: { ...f.config.checkout, cliniko: { ...cliniko,
      producer: { keyRef: producer.keyRef, pem: producer.publicKey.export({ type: "spki", format: "pem" }).toString() } }, stripe }, webhook } };
  child.send(start);
  const nextCycle = async () => {
    const queued = counts.shift(); if (queued) return queued;
    assert.equal(waiting, undefined);
    return new Promise<FinancialConsumerCycle>((resolve, reject) => {
      const timer = setTimeout(() => { waiting = undefined; reject(new FinancialConsumerCycleWaitTimeout("Synthetic process cycle deadline")); }, 10_000);
      waiting = { resolve: cycle => { clearTimeout(timer); resolve(cycle); }, reject: error => { clearTimeout(timer); reject(error); } };
    });
  };
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) { assert.equal(child.kill("SIGKILL"), true); assert.equal(await terminal, "SIGKILL"); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic process ready deadline")), 10_000); })]);
    const nextRetention = async (): Promise<Retention> => {
      if (retention) { const result = retention; retention = undefined; return result; }
      assert.equal(waitingRetention, undefined);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waitingRetention = undefined; reject(new Error("Synthetic resend retention deadline")); }, 10_000);
        waitingRetention = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      });
    };
    return { child, port, nextCycle, nextRetention, kill, output, get expiryObservation() { return expiryObservations.value; } };
  } catch (error) { await kill(); throw error; }
  finally { if (timer) clearTimeout(timer); }
}
