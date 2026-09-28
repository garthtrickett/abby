import { resolve } from "node:path";
import { MemoryLedger } from "../../core/ledger.ts";
import { EffectRecovery } from "../../core/effect-recovery.ts";
import { EffectWorkLoop } from "../../core/effect-work-loop.ts";
import type { LocationScope } from "../../core/model.ts";
import { CallReview } from "../../reference/call-review.ts";
import { CallOutcomeReport } from "../../reference/call-outcome-report.ts";
import { ReferenceClinicHost } from "../../reference/clinic-host.ts";
import { CommandGateway } from "../../reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../reference/policy-store.ts";
import { StaffQueue } from "../../reference/staff-queue.ts";
import { StaffAlertMonitor } from "../../reference/staff-alert-monitor.ts";
import { TextReception } from "../../reference/text-reception.ts";
import { MemoryKnowledgeCatalogue } from "../../reference/knowledge-catalogue.ts";
import { createDashboardServer } from "./server.ts";

const scope: LocationScope = { tenantId: "demo-tenant", clinicId: "demo-clinic", locationId: "demo-location" };
const ledger = new MemoryLedger();
const policy = new MemoryPolicyStore();
const host = new ReferenceClinicHost([], []);
const knowledge = new MemoryKnowledgeCatalogue();
const reception = new TextReception(ledger, policy, host, undefined, undefined, undefined, knowledge);
const started = await reception.startCall("demo-call", scope);
if (!started.ok) throw new Error(`demo call failed: ${started.error.kind}`);
const gateway = new CommandGateway({ actorRef: "demo-admin", role: "clinicAdmin", scope }, policy, reception,
  new CallReview(ledger), new StaffQueue(ledger), new CallOutcomeReport(ledger), ledger, knowledge);
const server = await createDashboardServer(gateway, resolve("dist/dashboard/app.js"));
const alerts = new StaffAlertMonitor(ledger, scope);
const effects = new EffectWorkLoop(new EffectRecovery(ledger, () => host, scope), result => {
  if (!result.ok || result.value.failed.length > 0) process.stderr.write("Abby effect recovery needs operator review.\n");
}, { prepare: now => alerts.scan(now) });
server.on("close", () => { void effects.stop(); });
const port = Number(process.env.ABBY_DASHBOARD_PORT ?? "3400");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid ABBY_DASHBOARD_PORT");
server.listen(port, "127.0.0.1", () => {
  effects.start();
  process.stdout.write(`Abby local dashboard: http://127.0.0.1:${port}\n`);
});
