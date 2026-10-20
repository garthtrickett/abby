/** Isolated owning-host runner proof. Provider ports and grants are fixtures;
 * only fixed cycles/statuses leave IPC. No public provider or mail endpoint. */
import { serveClinikoVoice } from "../../scripts/serve-cliniko-voice.ts";
import { ClinikoFinancialConsumer } from "../../src/standalone/cliniko-financial-consumer.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { financialConsumerFixture } from "./financial-consumer.ts";
import { intentValue, value } from "./financial-retention.ts";

if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || !process.env.DATABASE_URL?.includes("/abby_test_financial_runner_") ||
    process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5") throw new Error("isolated financial runner required");
const mode = process.env.ABBY_SYNTHETIC_FINANCIAL_RUNNER;
if (!["active", "foreignScope", "foreignBudget", "invalid", "alreadyStarted"].includes(mode ?? "")) throw new Error("invalid synthetic financial mode");
let fixture: Awaited<ReturnType<typeof financialConsumerFixture>> | undefined;
let service: AbortSignal | undefined;
let supplied: ClinikoFinancialConsumer | undefined;
let closeCalls = 0;
const receive = (raw: unknown) => {
  if (!raw || typeof raw !== "object" || !("kind" in raw) || !fixture) return;
  if (raw.kind === "paid") { fixture.paid(); process.send?.({ kind: "paidApplied" }); }
  if (raw.kind === "denyRun") { fixture.denyRun(); process.send?.({ kind: "runDenied" }); }
  if (raw.kind === "retire") { fixture.retire(); process.send?.({ kind: "retired" }); }
};
process.on("message", receive);
try {
  await serveClinikoVoice({
    clinikoFetch: async () => { throw new Error("no synthetic voice provider configured"); },
    openaiFetch: async () => { throw new Error("no synthetic voice model configured"); },
    financialConsumer: async context => {
      service = context.serviceSignal;
      if (mode === "invalid") return {} as never;
      const intent = { ...intentValue(), scope: { ...context.scope, ...(mode === "foreignScope" ? { locationId: "other" } : {}) },
        credentialFingerprint: clinikoCredentialFingerprint(context.apiKey) };
      fixture = await financialConsumerFixture({ checkout: { native: { intent,
        config: { apiKey: context.apiKey, rateBudget: mode === "foreignBudget" ? { claim: context.rateBudget.claim.bind(context.rateBudget), observe429: context.rateBudget.observe429.bind(context.rateBudget) } : context.rateBudget },
        barrierFactory: native => new PostgresFinancialEffectBarrier(context.db, native.scope, value(financialRecordOwnerBinding(native))) } } });
      await fixture.consumer.close();
      const f = fixture;
      supplied = value(ClinikoFinancialConsumer.create(f.config, f.authority, { ...f.dependencies,
        onCycle(cycle) { f.dependencies.onCycle(cycle); process.send?.({ ...cycle, kind: "cycle", cycleKind: cycle.kind,
          sessions: f.sessions.length, messages: f.messages.length }); } }));
      const close = supplied.close.bind(supplied);
      Object.defineProperty(supplied, "close", { value: async () => { closeCalls++; await close(); } });
      if (mode === "alreadyStarted") { f.denyRun(); value(supplied.start(new AbortController().signal)); }
      return supplied;
    },
  });
  process.send?.({ kind: "stopped", aborted: service?.aborted === true, closed: closeCalls > 0 });
} catch (error) {
  const reason = error instanceof RangeError && error.message === "financial consumer account mismatch" ? "accountMismatch" :
    error instanceof RangeError && error.message === "financial consumer unavailable" ? "invalidConsumer" :
    error instanceof Error && error.message === "financial consumer unavailable" ? "startRejected" : "unavailable";
  process.send?.({ kind: "refused", reason, closeCalls, sessions: fixture?.sessions.length ?? 0, messages: fixture?.messages.length ?? 0 });
  process.exitCode = 1;
} finally {
  process.off("message", receive); await supplied?.close(); await fixture?.consumer.close();
  if (process.connected) process.disconnect();
}
