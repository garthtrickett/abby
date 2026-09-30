import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { VerifiedAppointmentReadSession } from "../../src/standalone/verified-appointment-read-session.ts";
import { CallAdmissionService } from "../../src/voice/admission.ts";

// The controlled write probe owns this synthetic patient and its cleanup.
// Stdin contains its credential and IDs; stdout contains only status and counts.
try {
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  const scope = { tenantId: "demo-probe", clinicId: "demo-probe", locationId: "demo-probe" };
  const patientId = String(input.patientId);
  const now = new Date().toISOString();
  const to = new Date(Date.parse(now) + 7 * 86_400_000).toISOString();
  const number = "+61400000001";
  const inbound = { key: { accountRef: "synthetic-probe", providerCallRef: randomUUID() },
    dialedNumber: "+61200000001", presentedCallerNumber: number, receivedAt: now };
  const policy = { ...referenceDefaultPolicy(scope), automationEnabled: true, staffWorkEnabled: false };
  const ledger = new MemoryLedger();
  const admitted = await new CallAdmissionService(ledger, async () => ok(policy),
    () => now, async () => ok(true)).begin(inbound);
  if (!admitted.ok) throw new Error("admission");

  let protectedReads = 0;
  const providerFetch: typeof fetch = async (target, init) => {
    if (new URL(String(target)).pathname === "/v1/individual_appointments") protectedReads += 1;
    return fetch(target, init);
  };
  const session = VerifiedAppointmentReadSession.create({ receipt: admitted.value.receipt, inbound,
    sessionId: randomUUID(), policyVersion: "synthetic-probe-v1", maxAttempts: 1,
    lookup: { async candidates(readScope, presented) {
      return readScope.tenantId === scope.tenantId && readScope.clinicId === scope.clinicId &&
        presented === number
        ? ok({ kind: "one" as const, candidateIds: [patientId] })
        : err({ kind: "unavailable" as const });
    } },
    authority: { async attest(request) {
      return request.token === "syntheticHostTokenOne" && request.candidateIds.length === 1 &&
        request.candidateIds[0] === patientId
        ? ok({ scope: request.scope, callId: request.callId, sessionId: request.sessionId,
          patientId, operations: [request.operation], policyVersion: request.policyVersion })
        : err({ kind: "denied" as const });
    } },
    policy: { async current() { return ok({ scope, enabled: true, version: "synthetic-probe-v1" }); } },
    cliniko: { apiKey: String(input.apiKey), contactEmail: String(input.contactEmail),
      businessId: String(input.businessId) }, fetchPort: providerFetch });
  if (!session.ok) throw new Error("composition");
  try {
    const before = await session.value.appointments.list(scope, "unverified-reference", now, to, now);
    const unverifiedNoRead = !before.ok && protectedReads === 0;
    const proof = await session.value.issueReadProof("syntheticHostTokenOne");
    if (!proof.ok) throw new Error("proof");
    const read = await session.value.appointments.list(scope, proof.value.verificationRef, now, to, now);
    const readsAfterProof = protectedReads;
    session.value.dispose();
    const after = await session.value.appointments.list(scope, proof.value.verificationRef, now, to, now);
    const disposedNoRead = !after.ok && protectedReads === readsAfterProof;
    if (!read.ok) {
      process.stdout.write(JSON.stringify({ ok: false, kind: read.error.kind,
        unverifiedNoRead, disposedNoRead, protectedReads }));
      process.exitCode = 1;
    } else {
      process.stdout.write(JSON.stringify({ ok: true, count: read.value.appointments.length,
        exact: read.value.appointments.length === 1 &&
          read.value.appointments[0]?.appointmentRef === String(input.appointmentId),
        timeZone: read.value.timeZone, unverifiedNoRead, disposedNoRead, protectedReads }));
    }
  } finally { session.value.dispose(); }
} catch {
  process.stdout.write(JSON.stringify({ ok: false, kind: "probeFailure" }));
  process.exitCode = 1;
}
