import { createHash, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new RangeError(`missing ${name}`);
  return value;
}

export type ClinikoAdminRunnerPorts = Readonly<{ clinikoFetch?: typeof fetch; bundlePath?: string }>;

/** Owner-only loopback administration for a single configured clinic location. */
export async function serveClinikoAdmin(ports: ClinikoAdminRunnerPorts = {}): Promise<void> {
  const portText = process.env.ABBY_ADMIN_PORT ?? "3401";
  const port = Number(portText);
  if (!/^[0-9]+$/.test(portText) || !Number.isSafeInteger(port) || port < 0 || port > 65_535 ||
      (port === 0 && process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1")) {
    throw new RangeError("invalid ABBY_ADMIN_PORT");
  }
  const token = required("ABBY_ADMIN_ACCESS_TOKEN_HEX");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new RangeError("invalid ABBY_ADMIN_ACCESS_TOKEN_HEX");
  const actorRef = required("ABBY_ADMIN_ACTOR_REF");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(actorRef)) {
    throw new RangeError("invalid ABBY_ADMIN_ACTOR_REF");
  }
  const scope = { tenantId: required("ABBY_TENANT_ID"), clinicId: required("ABBY_CLINIC_ID"),
    locationId: required("ABBY_LOCATION_ID") };
  const route = { accountRef: required("ABBY_TWILIO_ACCOUNT_SID"),
    dialedNumber: required("ABBY_TWILIO_TEST_NUMBER"), routeVersion: required("ABBY_VOICE_ROUTE_VERSION") };
  const weekMode = process.env.ABBY_SEVEN_DAY_AVAILABILITY_ENABLED;
  if (weekMode !== undefined && weekMode !== "0" && weekMode !== "1") {
    throw new RangeError("invalid ABBY_SEVEN_DAY_AVAILABILITY_ENABLED");
  }
  const actor = { actorRef, role: "clinicAdmin" as const, scope };
  const expected = createHash("sha256").update(`Basic ${Buffer.from(`abby-admin:${token}`).toString("base64")}`).digest();
  const unauthorized = (response: ServerResponse): void => {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Abby local clinic admin", charset="UTF-8"',
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff" });
    response.end(JSON.stringify({ ok: false, error: { kind: "forbidden" } }));
  };
  const databaseUrl = required("DATABASE_URL");
  const apiKey = required("ABBY_CLINIKO_API_KEY");
  const contactEmail = required("ABBY_CLINIKO_CONTACT_EMAIL");
  // Reject invalid startup configuration before loading the database/dashboard composition.
  const [{ createStandaloneClinikoAdminDashboard }, { readSpeechGateStatus }, { connectPostgres }] =
    await Promise.all([import("../src/standalone/cliniko-admin-dashboard.ts"),
      import("./read-speech-gate-status.ts"), import("../src/storage/connect.ts")]);
  const db = connectPostgres(databaseUrl);
  try {
    const prepared = await createStandaloneClinikoAdminDashboard({ db, scope, route,
      apiKey, contactEmail,
      sevenDayAvailabilityEnabled: weekMode === "1",
      ...(process.env.ABBY_CLINIKO_BUDGET_USER_REF
        ? { sharedBudgetUserRef: process.env.ABBY_CLINIKO_BUDGET_USER_REF } : {}),
      publicOrigin: `http://127.0.0.1:${port}`,
      resolveActor: request => {
        const authorization = request.headers.authorization;
        if (typeof authorization !== "string" || authorization.length > 512) return null;
        const supplied = createHash("sha256").update(authorization).digest();
        return timingSafeEqual(supplied, expected) ? actor : null;
      },
      unauthorized,
      readSpeechGate: () => readSpeechGateStatus(),
      bundlePath: ports.bundlePath ?? resolve("dist/dashboard/cliniko-admin.js"),
      ...(ports.clinikoFetch ? { fetch: ports.clinikoFetch } : {}),
    });
    if (!prepared.ok) throw new Error("local clinic admin unavailable");
    const server = prepared.value;
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
    });
    const address = server.address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1" || address.port < 1) {
      throw new Error("local clinic admin listener address unavailable");
    }
    process.send?.({ kind: "listenerReady", port: address.port });
    process.stdout.write(`Abby local clinic admin ready on http://127.0.0.1:${address.port}\n`);
    await new Promise<void>(resolveStop => {
      process.once("SIGINT", resolveStop);
      process.once("SIGTERM", resolveStop);
    });
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  } finally { await db.destroy(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await serveClinikoAdmin(); }
  catch (error) {
    const message = error instanceof Error && /^(missing|invalid) ABBY_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "local clinic admin unavailable";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
