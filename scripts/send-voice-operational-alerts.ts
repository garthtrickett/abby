import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkVoiceOperationsWindow } from "./check-voice-operations.ts";

type AlertDeliveryPorts = Readonly<{ fetch?: typeof fetch; allowTestLoopbackHttp?: boolean }>;

function destination(raw: string, allowTestLoopbackHttp: boolean): string {
  const url = new URL(raw);
  const testLoopback = allowTestLoopbackHttp && url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if ((url.protocol !== "https:" && !testLoopback) || url.username || url.password ||
      url.search || url.hash) throw new RangeError("invalid operational alert destination");
  return url.toString();
}

/** A 2xx response proves webhook acceptance only; the stable key lets a receiver deduplicate retries. */
export async function sendVoiceOperationalAlerts(env: NodeJS.ProcessEnv,
  ports: AlertDeliveryPorts = {}): Promise<Readonly<{ date: string; accepted: number }>> {
  const token = env.ABBY_VOICE_ALERT_TOKEN_HEX;
  const rawUrl = env.ABBY_VOICE_ALERT_WEBHOOK_URL;
  if (!token || !/^[a-f0-9]{64}$/i.test(token) || !rawUrl) {
    throw new RangeError("operational alert delivery unavailable");
  }
  const url = destination(rawUrl, ports.allowTestLoopbackHttp === true);
  const result = await checkVoiceOperationsWindow(env);
  const scope = [env.ABBY_TENANT_ID?.trim(), env.ABBY_CLINIC_ID?.trim(), env.ABBY_LOCATION_ID?.trim()];
  const send = ports.fetch ?? fetch;
  const crossed = result.days.flatMap(day => day.alerts.map(alert => ({ date: day.date, alert })));
  const attempts = await Promise.allSettled(crossed.map(async ({ date, alert }) => {
    const alertKey = createHmac("sha256", Buffer.from(token, "hex"))
      .update(JSON.stringify([scope, date, alert.kind, alert.threshold])).digest("hex");
    const response = await send(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
        "idempotency-key": alertKey },
      body: JSON.stringify({ schemaVersion: 1, date, kind: alert.kind,
        count: alert.count, threshold: alert.threshold, alertKey }),
    });
    await response.body?.cancel();
    if (response.status < 200 || response.status >= 300) {
      throw new Error("operational alert delivery unavailable");
    }
  }));
  if (attempts.some(attempt => attempt.status === "rejected")) {
    throw new Error("operational alert delivery unavailable");
  }
  return { date: result.date, accepted: attempts.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 2) throw new RangeError("invalid arguments");
    process.stdout.write(`${JSON.stringify(await sendVoiceOperationalAlerts(process.env))}\n`);
  } catch {
    process.stderr.write("operational alert delivery unavailable\n");
    process.exitCode = 1;
  }
}
