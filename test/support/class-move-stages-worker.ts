import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { ClinikoClassAttendanceMove } from "../../src/standalone/cliniko-class-attendance-move.ts";
import type { ClinikoClassMoveRequest } from "../../src/standalone/cliniko-class-attendance-move.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { claimClinikoBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { err, ok } from "../../src/core/model.ts";
import type { LocationScope } from "../../src/core/model.ts";

type Service = { practitionerId: string; appointmentTypeId: string; className: string };
const mode = process.argv[2];
if (!["complete", "park", "discover"].includes(mode!) || process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || !process.env.DATABASE_URL || !process.send) throw new Error("isolated staged fixture required");
let source = "";
for await (const chunk of process.stdin) { source += String(chunk); if (source.length > 12000) throw new Error("synthetic input too large"); }
const input = JSON.parse(source) as { scope: LocationScope; proxy: string; recallTypeId?: string; request?: ClinikoClassMoveRequest; source?: Service; destination?: Service; now?: string };
const fields = mode === "discover" ? ["scope", "proxy", "recallTypeId"] : ["scope", "proxy", "request", "source", "destination", "now"];
if (Object.keys(input).sort().join(",") !== fields.sort().join(",") || !input.scope.tenantId.startsWith("pass-move-")) throw new Error("unexpected synthetic stage context");
const proxy = new URL(input.proxy);
if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1") throw new Error("local synthetic proxy required");
const db = connectPostgres(process.env.DATABASE_URL), apiKey = "synthetic-class-au5", version = "three-window-v1";
const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
const fetchPort: typeof fetch = (original, init) => {
  const target = new URL(String(original)); if (target.origin !== "https://api.au5.cliniko.com") throw new Error("unexpected synthetic origin");
  return fetch(`${proxy.origin}${target.pathname}${target.search}`, init);
};
const lifetime = new AbortController();
try {
  const cliniko = { apiKey, contactEmail: "dev@example.test", rateBudget: budget, businessId: "11" };
  if (mode === "discover") {
    const made = ClinikoRecallReader.create({ ...cliniko, scope: input.scope }, fetchPort);
    if (!made.ok) throw new Error("reader configuration failed");
    const discovered = await made.value.discoverPendingReviews(input.scope, input.recallTypeId!);
    if (!discovered.ok) throw new Error("native discovery failed");
    let stagedMoves = 0, invalid = 0;
    for (const record of discovered.value.pending) {
      if (record.kind !== "review") { invalid++; continue; }
      const r = record.envelope.request;
      if (r.credentialFingerprint === clinikoCredentialFingerprint(apiKey) && r.operation.kind === "classMove" && r.operation.quotaStaging === version) stagedMoves++;
      else invalid++;
    }
    process.send({ kind: "discovered", pending: discovered.value.pending.length, stagedMoves, invalid });
  } else {
    const request = input.request!;
    if (request.patientId !== "42" || !request.pass || !input.source || !input.destination || !Number.isFinite(Date.parse(input.now!))) throw new Error("synthetic request required");
    const began = performance.now(), initial = Date.parse(input.now!), clock = () => new Date(initial + Math.floor(performance.now() - began)).toISOString();
    let proofRef = request.verificationRef, proofExpiry = initial + 300000;
    const made = ClinikoClassAttendanceMove.create({ scope: input.scope, cliniko, source: input.source, destination: input.destination,
      proof: { verifyPatient: async (scope, ref) => ref === proofRef && Date.parse(clock()) < proofExpiry
        ? ok({ scope, patientRef: "42", verificationRef: ref, expiresAt: new Date(proofExpiry).toISOString() }) : err({ kind: "notFound", target: "patient" }) },
      policyVersion: "policy-1", termsVersion: "pass-move-terms-1", timeZone: "Australia/Sydney", recallTypeId: "7", clock, signal: lifetime.signal,
      fetchPort, quotaStaging: { version }, stageRequestCosts: { proof: 0, permit: 0, passSelect: 0, passAllow: 0 }, casePass: { stagingContractVersion: "unlinked-recovery-v1", authority: {
        select: async () => ({ source: { patientCaseId: request.pass!.source.patientCaseId, entitlementRef: request.pass!.source.entitlementRef },
          destination: { patientCaseId: request.pass!.destination.patientCaseId, entitlementRef: request.pass!.destination.entitlementRef } }),
        allows: async () => true,
      } } });
    if (!made.ok) throw new Error("native stage configuration failed");
    const prepared = made.value.prepareStagesOnce(request); if (!prepared.ok) throw new Error("native stages unavailable");
    let phase = 0, waits = 0, proofPhase = 0;
    while (phase < 5) {
      // Independently issued synthetic private proof for this phase, not an
      // extension of the initial five-minute grant. No real email is sent.
      if (phase > 0 && proofPhase !== phase) { proofRef = `synthetic-private-stage-proof-${phase}`; proofExpiry = Date.parse(clock()) + 300000; proofPhase = phase; }
      const confirmation = { contractVersion: version, verificationRef: proofRef, confirmationRef: randomUUID(), expiresAt: phase === 0 ? request.expiresAt : new Date(Date.parse(clock()) + 110000).toISOString() };
      const step = await prepared.value.advanceOnce(confirmation, lifetime.signal, async q => q.confirmationRef === confirmation.confirmationRef && q.request.verificationRef === proofRef && q.stagingContractVersion === version);
      if (!step.ok) throw new Error("stage failed");
      const result = step.value;
      if (result.kind === "waiting") {
        const delay = result.denial.kind === "rateLimited" ? result.denial.retryAfterMs : undefined;
        if (!delay || delay < 1 || delay > 60000 || ++waits > 4) throw new Error("unexpected quota denial");
        process.send({ kind: "quotaWait", milliseconds: delay });
        await new Promise(resolve => setTimeout(resolve, delay + 75)); continue;
      }
      phase++;
      const rows = await db.selectFrom("cliniko_request_budgets").select(["sent_at_ms", "max_per_minute"]).execute();
      const held = await db.selectFrom("cliniko_request_reservations").select(["remaining"]).execute();
      process.send({ kind: "stage", phase, status: result.kind, next: result.kind === "staged" ? result.next : undefined,
        outcome: result.observation.kind, used: rows.map(r => Array.isArray(r.sent_at_ms) ? r.sent_at_ms.length : -1), held: held.length });
      if (mode === "park") { await once(process, "message"); throw new Error("parked owner must be killed, never resumed"); }
      if (result.kind === "finished") {
        if (result.observation.kind !== "moved") throw new Error("move not inspected complete");
        process.send({ kind: "completed", phases: phase, waits }); break;
      }
      // Explicit competing account traffic forces each inter-stage quota
      // wait even when two smaller complete allocations could otherwise fit.
      for (let i = 0; i < 180; i++) if (await claimClinikoBudget(budget)) break;
    }
  }
} finally { lifetime.abort(); await db.destroy(); process.disconnect?.(); }
