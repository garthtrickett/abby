import { fileURLToPath } from "node:url";
import { connectPostgres } from "../src/storage/connect.ts";
import { OwnerFileAdminDirectory } from "../src/standalone/identity/owner-file-admin-directory.ts";
import { ClinikoQueueMonitor } from "../src/standalone/cliniko-queue-monitor.ts";
import type { ClinikoQueueMonitorConfig } from "../src/standalone/cliniko-queue-monitor.ts";

type Ports = Pick<ClinikoQueueMonitorConfig, "clinikoFetch" | "alertFetch" | "allowTestLoopbackHttp">;
export async function monitorClinikoQueue(env: NodeJS.ProcessEnv, ports: Ports = {}) {
  const required = (name: string) => { const value = env[name]?.trim(); if (!value) throw new Error("Cliniko queue monitoring unavailable"); return value; };
  const scope = { tenantId: required("ABBY_TENANT_ID"), clinicId: required("ABBY_CLINIC_ID"), locationId: required("ABBY_LOCATION_ID") };
  const rawCadence = required("ABBY_CLINIKO_QUEUE_POLL_MINUTES");
  if (!/^[1-9][0-9]{0,3}$/.test(rawCadence)) throw new Error("Cliniko queue monitoring unavailable");
  const db = connectPostgres(required("DATABASE_URL"));
  try {
    const monitor = await ClinikoQueueMonitor.create({ ...ports, db, scope, apiKey: required("ABBY_CLINIKO_API_KEY"), contactEmail: required("ABBY_CLINIKO_CONTACT_EMAIL"),
      businessId: required("ABBY_CLINIKO_BUSINESS_ID"), recallTypeId: required("ABBY_CLINIKO_RECALL_TYPE_ID"), timeZone: required("ABBY_CLINIKO_RECALL_TIME_ZONE"),
      policyVersion: required("ABBY_CLINIKO_QUEUE_POLICY_VERSION"), staffApprovalPath: required("ABBY_CLINIKO_STAFF_APPROVAL_PATH"),
      monitorApprovalPath: required("ABBY_CLINIKO_QUEUE_MONITOR_APPROVAL_PATH"), directory: new OwnerFileAdminDirectory(required("ABBY_ADMIN_DIRECTORY_PATH"), scope),
      destination: required("ABBY_VOICE_ALERT_WEBHOOK_URL"), alertTokenHex: required("ABBY_VOICE_ALERT_TOKEN_HEX"), pollEveryMinutes: Number(rawCadence),
      ...(env.ABBY_CLINIKO_BUDGET_USER_REF ? { sharedBudgetUserRef: env.ABBY_CLINIKO_BUDGET_USER_REF } : {}) });
    if (!monitor.ok) throw new Error("Cliniko queue monitoring unavailable"); return await monitor.value.run();
  } finally { await db.destroy(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 2) throw new Error("invalid arguments");
    const result = await monitorClinikoQueue(process.env); process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "queueKnown") process.exitCode = result.status === "queueUnavailable" ? 2 : 1;
  } catch { process.stderr.write("Cliniko queue monitoring unavailable\n"); process.exitCode = 1; }
}
