import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { FinancialConsumerConfig, FinancialConsumerCycle } from "../../src/standalone/cliniko-financial-consumer.ts";
import type { ClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import type { CheckoutCreationReceipt } from "../../src/standalone/cliniko-stripe-checkout.ts";
import type { SmtpMailConfig } from "../../src/standalone/smtp-text-mail-transport.ts";
import type { FinancialConsumerProcessSetup } from "./financial-consumer-process.ts";
import { now } from "./financial-retention.ts";

export type FinancialConsumerPeerFixture = Readonly<{ config: FinancialConsumerConfig; intent: ClinikoFinancialIntent;
  dependencies: Readonly<{ native: typeof fetch; stripe: typeof fetch }>; approved: Set<string>; receipts: CheckoutCreationReceipt[] }>;
export type FinancialConsumerPeerOptions = Readonly<{ now?: string; enableCheckoutExpiry?: boolean; producerAdmitted?(): boolean;
  allows?(purpose: string, query: unknown): boolean; holdExpiryReply?: boolean; onExpirySubmitted?(): void }>;
/** Actual compiled host with outliving independently authorized fixture providers.
 * Private RPC payloads stay in volatile fixture memory, never operational logs or
 * a local retry file. Consumers receive only native discovery, not selected refs. */
export async function financialConsumerPeer(f: FinancialConsumerPeerFixture, smtp: SmtpMailConfig, directory: string, options: FinancialConsumerPeerOptions = {}) {
  const child = fork(new URL("../../dist/runtime/test/support/financial-consumer-process.js", import.meta.url), [], {
    cwd: directory, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" } });
  const terminal = new Promise<NodeJS.Signals | null>(resolve => child.once("exit", (_code, signal) => resolve(signal)));
  const counts: FinancialConsumerCycle[] = [], output: string[] = [];
  child.stdout?.on("data", data => output.push(String(data))); child.stderr?.on("data", data => output.push(String(data)));
  let waiting: { resolve(c: FinancialConsumerCycle): void; reject(e: Error): void } | undefined;
  let resolveReady!: (port: number) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const fail = (error: Error) => { rejectReady(error); waiting?.reject(error); };
  child.once("error", fail); child.once("exit", () => fail(new Error("Synthetic consumer process terminal")));
  child.on("message", async (raw: unknown) => {
    const m = raw as { kind: string; id: number; port: number; cycle: FinancialConsumerCycle; data: unknown };
    try {
      if (m.kind === "ready") { resolveReady(m.port); return; }
      if (m.kind === "cycle") {
        if (waiting) { const next = waiting; waiting = undefined; next.resolve(m.cycle); } else counts.push(m.cycle); return;
      }
      if (m.kind === "workerError") throw new Error("Synthetic compiled consumer unavailable");
      let data: unknown;
      if (m.kind === "fetch") {
        const request = m.data as { input: string; method: string; body?: string; headers: Record<string, string> };
        const response = await (request.input.startsWith("https://api.stripe.com/") ? f.dependencies.stripe : f.dependencies.native)(request.input,
          { method: request.method, redirect: "error", headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) });
        if (options.holdExpiryReply && request.method === "POST" && request.input.endsWith("/expire")) { options.onExpirySubmitted?.(); return; }
        data = { body: await response.text(), status: response.status };
      } else if (m.kind === "grant") {
        const grant = m.data as { purpose: string; query: { checkoutRef?: string; binding?: { checkoutRef: string } } };
        data = grant.purpose === "producer" ? (options.producerAdmitted?.() ?? true) : grant.purpose === "providerBinding" || grant.purpose === "messageBinding"
          ? f.approved.has(grant.query.checkoutRef ?? grant.query.binding?.checkoutRef ?? "") : options.allows?.(grant.purpose, grant.query) ?? true;
      } else if (m.kind === "claim") data = await f.config.checkout.cliniko.rateBudget.claim();
      else if (m.kind === "observe429") data = await f.config.checkout.cliniko.rateBudget.observe429(null);
      else if (m.kind === "acknowledged") { const receipt = m.data as CheckoutCreationReceipt; f.receipts.push(receipt); f.approved.add(receipt.checkoutRef); data = true; }
      else throw new Error("Unexpected synthetic consumer operation");
      if (child.connected) child.send({ kind: "reply", id: m.id, data });
    } catch { fail(new Error("Synthetic provider or grant failed")); }
  });
  const { producer, rateBudget: _budget, clock: _nativeClock, ...cliniko } = f.config.checkout.cliniko;
  const { clock: _stripeClock, ...stripe } = f.config.checkout.stripe, { clock: _webhookClock, ...webhook } = f.config.webhook;
  const start: FinancialConsumerProcessSetup = { kind: "start", now: options.now ?? now, ...(options.enableCheckoutExpiry ? { enableCheckoutExpiry: true } : {}), smtp: { ...smtp, ...(smtp.ca ? { ca: Buffer.from(smtp.ca).toString() } : {}) },
    config: { ...f.config, checkout: { ...f.config.checkout, cliniko: { ...cliniko,
      producer: { keyRef: producer.keyRef, pem: producer.publicKey.export({ type: "spki", format: "pem" }).toString() } }, stripe }, webhook } };
  child.send(start);
  const nextCycle = async () => {
    const queued = counts.shift(); if (queued) return queued;
    assert.equal(waiting, undefined);
    return new Promise<FinancialConsumerCycle>((resolve, reject) => {
      const timer = setTimeout(() => { waiting = undefined; reject(new Error("Synthetic process cycle deadline")); }, 10_000);
      waiting = { resolve: cycle => { clearTimeout(timer); resolve(cycle); }, reject: error => { clearTimeout(timer); reject(error); } };
    });
  };
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) { assert.equal(child.kill("SIGKILL"), true); assert.equal(await terminal, "SIGKILL"); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic process ready deadline")), 10_000); })]);
    return { child, port, nextCycle, kill, output };
  } catch (error) { await kill(); throw error; }
  finally { if (timer) clearTimeout(timer); }
}
