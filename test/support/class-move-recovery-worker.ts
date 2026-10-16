import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { OwnerFileClassPolicy } from "../../src/standalone/owner-file-class-policy.ts";
import { OwnerFileClassMovePolicy } from "../../src/standalone/owner-file-class-move-policy.ts";
import { ClinikoClassMoveRecovery } from "../../src/standalone/cliniko-class-move-recovery.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type { ClassMoveRecoveryRequest } from "../../src/standalone/cliniko-class-move-recovery.ts";

type Input = Readonly<{ scope: LocationScope; proxy: string; sourcePath: string; destinationPath: string; movePath: string;
  accountPath: string; actorRef: string; policyVersion: string; businessId: string; recallTypeId: string; timeZone: string;
  source: Readonly<{ practitionerId: string; appointmentTypeId: string }>;
  destination: Readonly<{ practitionerId: string; appointmentTypeId: string }>;
  now: string; request: ClassMoveRecoveryRequest }>;

if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || !process.env.DATABASE_URL) throw new Error("isolated cold recovery fixture required");
const target = new URL(process.env.DATABASE_URL);
if (target.hostname !== "127.0.0.1" || !target.pathname.startsWith("/abby_recovery_")) throw new Error("isolated cold recovery database required");
let text = "";
for await (const chunk of process.stdin) { text += String(chunk); if (text.length > 12000) throw new Error("synthetic context too large"); }
const input = JSON.parse(text) as Input;
if (Object.keys(input).sort().join(",") !== ["scope", "proxy", "sourcePath", "destinationPath", "movePath", "accountPath", "actorRef", "policyVersion",
  "businessId", "recallTypeId", "timeZone", "source", "destination", "now", "request"].sort().join(",") ||
  !input.scope.tenantId.startsWith("verification-") || !Number.isFinite(Date.parse(input.now))) throw new Error("unexpected synthetic cold recovery context");
const proxy = new URL(input.proxy);
if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1") throw new Error("local synthetic provider required");
const db = connectPostgres(process.env.DATABASE_URL), apiKey = "synthetic-class-au5";
try {
  const directory = new OwnerFileAdminDirectory(input.accountPath, input.scope), clock = () => input.now;
  const binding = { scope: input.scope, policyVersion: input.policyVersion, businessId: input.businessId, recallTypeId: input.recallTypeId,
    timeZone: input.timeZone, credentialFingerprint: clinikoCredentialFingerprint(apiKey), directory, clock };
  const a = await OwnerFileClassPolicy.capture({ ...binding, path: input.sourcePath, ...input.source });
  const b = await OwnerFileClassPolicy.capture({ ...binding, path: input.destinationPath, ...input.destination });
  if (!a.ok || !b.ok) throw new Error("cold recovery policies unavailable");
  const source = await a.value.current(input.scope), destination = await b.value.current(input.scope);
  if (!source.ok || !destination.ok) throw new Error("cold recovery policies unavailable");
  const movement = await OwnerFileClassMovePolicy.capture({ ...binding, path: input.movePath,
    sourceServiceRef: source.value.serviceRef, destinationServiceRef: destination.value.serviceRef });
  if (!movement.ok) throw new Error("cold recovery movement unavailable");
  const nativeBudget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const fetchPort: typeof fetch = (original, init) => {
    const u = new URL(String(original));
    if (u.origin !== "https://api.au5.cliniko.com" || (init?.method ?? "GET") !== "GET") throw new Error("unexpected cold native request");
    return fetch(proxy.origin + u.pathname + u.search, init);
  };
  // Synthetic owning-host authentication/investigation only. No caller session,
  // code, private grant or stage reference arrives in this fresh process.
  const authority = { currentActor: async () => {
    const found = await directory.findByRef(input.actorRef); return found.ok && found.value ? found.value.actor : null;
  }, permitsReviewedResolution: async () => true };
  const pass = await movement.value.current(input.scope);
  if (!pass.ok) throw new Error("cold recovery movement unavailable");
  const recovery = new ClinikoClassMoveRecovery({ scope: input.scope,
    cliniko: { apiKey, contactEmail: "dev@example.test", businessId: input.businessId, rateBudget: nativeBudget },
    sourcePolicy: a.value, destinationPolicy: b.value, movePolicy: movement.value, directory, authority, clock, fetchPort,
    ...(pass.value.membership === "nativeCaseSessions" ? { classPassMoveAuthority: {
      select: async () => ({ source: { patientCaseId: "811222333444555666", entitlementRef: "private-move-source-entitlement" },
        destination: { patientCaseId: "811222333444555666", entitlementRef: "private-move-destination-entitlement" } }),
      allows: async query => query.patientId === "482746192837465" &&
        query.stagingContractVersion === pass.value.passMovement?.version &&
        ["inspection", "compensation"].includes(query.phase),
    } } : {}) });
  const result = await recovery.inspect(input.request);
  if (!result.ok) throw new Error("cold recovery unavailable");
  process.stdout.write(JSON.stringify({ kind: "coldReview", status: result.value }) + "\n");
} catch {
  process.stderr.write("Synthetic cold recovery unavailable\n"); process.exitCode = 1;
} finally { await db.destroy(); process.disconnect?.(); }
