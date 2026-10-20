import { monitorClinikoQueue } from "../../scripts/monitor-cliniko-queue.ts";
import { clinicQueueDate } from "../../src/standalone/cliniko-queue-pulse.ts";

if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_CLINIKO_API_KEY !== "synthetic-queue-au5" ||
    !process.env.DATABASE_URL?.includes("/abby_test_queue_") || process.env.ABBY_TENANT_ID !== "queue-monitor" ||
    !["known", "partial"].includes(process.env.ABBY_QUEUE_MONITOR_FIXTURE ?? "")) throw new Error("synthetic queue monitor requires an isolated fixture");
try {
  const provider: typeof fetch = async (_input, init) => {
    if (init?.method !== "GET") throw new Error("synthetic queue monitor permits only provider reads");
    const day = clinicQueueDate(new Date(), "Australia/Sydney"), yesterday = new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
    const row = (id: string, recalled: boolean, at: string) => ({ id, recalled, recall_at: at, archived_at: null,
      notes: "private queue patient notes canary", patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/918273645546372" } },
      recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/7" } } });
    return Response.json({ total_entries: process.env.ABBY_QUEUE_MONITOR_FIXTURE === "partial" ? 4 : 3,
      recalls: [row("1", false, yesterday), row("2", false, day), row("3", true, yesterday)] });
  };
  const result = await monitorClinikoQueue(process.env, { clinikoFetch: provider, allowTestLoopbackHttp: true });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "queueKnown") process.exitCode = result.status === "queueUnavailable" ? 2 : 1;
} catch { process.stderr.write("Cliniko queue monitoring unavailable\n"); process.exitCode = 1; }
