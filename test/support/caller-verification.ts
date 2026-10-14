import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClinikoAppointmentReader } from "../../src/cliniko/appointments.ts";
import { ClinikoVerificationContactReader } from "../../src/cliniko/verification-contact.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import type { AdmissionReceipt, CallPolicy, LocationScope } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CallerVerificationSession } from "../../src/standalone/caller-verification-session.ts";
import { DisabledStandaloneHost } from "../../src/standalone/disabled-host.ts";
import type { PatientCodeDelivery, PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import type { AdminAccount } from "../../src/standalone/identity/magic-link.ts";
import { OwnerFileCallerPolicy } from "../../src/standalone/owner-file-caller-policy.ts";
import type { CallerVerificationApproval } from "../../src/standalone/owner-file-caller-policy.ts";
import type { PatientOperation } from "../../src/standalone/transient-patient-proof.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import type { CallerCandidates } from "../../src/voice/caller-candidates.ts";
import { approvedSyntheticPolicy } from "./approved-voice.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export const verificationNow = "2026-10-04T06:00:00.000Z";
export const verificationCanaries = ["registered-session@example.test", "private-session-chart", "482746192837465"];

export async function callerVerificationFixture(options: { apiKey?: string; scope?: LocationScope; folder?: string; approved?: boolean; enabled?: boolean;
  contactRevision?: import("../../src/cliniko/contact-revision.ts").ClinikoContactRevisionReader;
  capturePolicy?: (policy: CallPolicy, folder: string) => Promise<CallPolicy>;
  operation?: PatientOperation; budget?: PatientVerificationBudget; delivery?: PatientCodeDelivery; timeoutMs?: number; cancellationExecute?: boolean; bookingExecute?: boolean; reschedulingExecute?: boolean; patientUpdateExecute?: boolean; staffWorkEnabled?: boolean } = {}) {
  const scope = options.scope ?? { tenantId: `verification-${crypto.randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const folder = options.folder ?? await mkdtemp(join(tmpdir(), "abby-caller-policy-"));
  const path = join(folder, "approval.json"), accountPath = join(folder, "accounts.json");
  const ledger = new MemoryLedger(async () => ok(true));
  class FixturePolicy extends MemoryPolicyStore {
    override async read(bound: LocationScope) {
      const found = await super.read(bound);
      return found.ok && (options.cancellationExecute || options.bookingExecute || options.reschedulingExecute || options.patientUpdateExecute)
        ? ok({ ...found.value, staffWorkEnabled: options.staffWorkEnabled ?? true,
          capabilities: { ...found.value.capabilities } }) : found;
    }
  }
  const policies = new FixturePolicy(options.bookingExecute ? "execute" : "requestOnly", () => now, async () => ok(true),
    { ...(options.cancellationExecute ? { cancellation: "execute" as const } : {}), ...(options.reschedulingExecute ? { rescheduling: "execute" as const } : {}),
      ...(options.patientUpdateExecute ? { patientUpdate: "execute" as const } : {}) });
  let now = verificationNow, permitted = true, email = verificationCanaries[0]!, phone = "+61400111222";
  let candidates: CallerCandidates = { kind: "one", candidateIds: [verificationCanaries[2]!] };
  let approval: CallerVerificationApproval = { scope, revision: "demo-revision-1", approverRef: "synthetic-admin",
    approvedAt: "2026-10-04T05:59:00.000Z", effectiveFrom: "2026-10-04T06:00:00.000Z", effectiveUntil: "2026-10-05T06:00:00.000Z",
    approved: options.approved ?? true, enabled: options.enabled ?? true, method: "emailOtp", maxAnswers: 3, lifetimeSeconds: 300,
    sharedNumbers: "deny", representatives: "deny", patientPermission: "independentClinicHost", operations: [options.operation ?? "appointments.read"] };
  let account: AdminAccount = { email: "clinic-admin@example.test", actor: { actorRef: "synthetic-admin", role: "clinicAdmin", scope }, membershipVersion: "member-1" };
  const replace = async (file: string, value: unknown) => {
    await writeFile(`${file}.new`, JSON.stringify(value), { mode: 0o600 }); await rename(`${file}.new`, file);
  };
  const mail: { email: string; code: string }[] = [], provider: string[] = [];
  let session: CallerVerificationSession | undefined;
  try {
    await replace(path, approval); await replace(accountPath, [account]);
    resultValue(await policies.changeAutomationEnabled(scope, "0", true, "synthetic-admin"));
    const currentVersion = async () => resultValue(await policies.read(scope)).policyVersion;
    if (options.bookingExecute) resultValue(await policies.changeBookingEnabled(scope, await currentVersion(), true, "synthetic-admin"));
    if (options.cancellationExecute) resultValue(await policies.changeCancellationEnabled(scope, await currentVersion(), true, "synthetic-admin"));
    if (options.reschedulingExecute) resultValue(await policies.changeReschedulingEnabled(scope, await currentVersion(), true, "synthetic-admin"));
    if (options.patientUpdateExecute) resultValue(await policies.changePatientCorrectionsEnabled(scope, "0", true, "synthetic-admin"));
    const base = approvedSyntheticPolicy(resultValue(await policies.read(scope)));
    const captured = options.capturePolicy ? await options.capturePolicy(base, folder) : base;
    const inbound = { key: { accountRef: "synthetic-account", providerCallRef: `provider-${crypto.randomUUID()}` },
      dialedNumber: "+6125550199", presentedCallerNumber: phone, receivedAt: now };
    const callId = callIdFor(inbound.key), sessionId = `session-${crypto.randomUUID()}`, runtime = new CallRuntime(ledger, scope);
    resultValue(await runtime.admit(callId, captured, { key: inbound.key, dialedNumber: inbound.dialedNumber,
      acceptedAt: now, deadline: "2026-10-04T06:00:30.000Z" }));
    resultValue(await runtime.activate(callId, sessionId, now));
    const receipt: AdmissionReceipt = resultValue(await ledger.findAdmission(callId))!;
    const directory = new OwnerFileAdminDirectory(accountPath, scope);
    const config = { path, scope, policyVersion: captured.policyVersion, operation: options.operation ?? "appointments.read", directory, clock: () => now };
    const policy = resultValue(await OwnerFileCallerPolicy.capture(config));
    const fetchPort: typeof fetch = async value => {
      const url = new URL(String(value)); provider.push(url.pathname);
      if (url.pathname.startsWith("/v1/patients/")) return Response.json({ id: verificationCanaries[2], email,
        archived_at: null, patient_phone_numbers: [{ number: phone, phone_type: "Mobile" }], notes: verificationCanaries[1] });
      if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", archived_at: null, time_zone_identifier: "Australia/Sydney" });
      assert.equal(url.pathname, "/v1/individual_appointments");
      return Response.json({ total_entries: 0, individual_appointments: [] });
    };
    const apiKey = options.apiKey ?? "synthetic-session-au5", contactEmail = "test@example.test";
    const sessionConfig = { receipt, inbound, sessionId, policyVersion: captured.policyVersion, operation: options.operation ?? "appointments.read",
      ledger, policyStore: policies, policy, lookup: { candidates: async () => ok(candidates) },
      contact: new ClinikoVerificationContactReader({ scope, apiKey, contactEmail, countryCallingCode: "61",
        ...(options.contactRevision ? { contactRevision: options.contactRevision } : {}) }, fetchPort),
      permission: { allows: async () => permitted }, budget: options.budget ?? { reserve: async () => true },
      delivery: options.delivery ?? { send: async (address: string, code: string) => { mail.push({ email: address, code }); return true; } },
      clock: () => now, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) };
    session = resultValue(CallerVerificationSession.create(sessionConfig));
    const reader = resultValue(ClinikoAppointmentReader.create({ scope, apiKey, contactEmail, businessId: "11" }, session.proof, fetchPort, () => now));
    const reception = new TextReception(ledger, policies, new DisabledStandaloneHost(), undefined, reader);
    const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope }, policies, reception);
    let turns = 0;
    const read = (verificationRef: string) => agent.submit({ kind: "appointments.read.v1", turn: { callId, sessionId,
      turnId: `appointment-read-${++turns}`, text: "Read my appointments", quality: "clear", at: now }, verificationRef,
      from: now, to: new Date(Date.parse(now) + 86_400_000).toISOString(), now });
    return { scope, path, accountPath, folder, approval, account, ledger, policies, runtime, callId, sessionId, receipt, inbound,
      policy, config, sessionConfig, session, mail, provider, reader, agent, read,
      replaceApproval: async (patch: Partial<CallerVerificationApproval>) => { approval = { ...approval, ...patch }; await replace(path, approval); },
      replaceAccount: async (patch: Partial<AdminAccount>) => { account = { ...account, ...patch }; await replace(accountPath, [account]); },
      setTime: (value: string) => { now = value; }, setPermitted: (value: boolean) => { permitted = value; },
      setEmail: (value: string) => { email = value; }, setPhone: (value: string) => { phone = value; },
      setCandidates: (value: CallerCandidates) => { candidates = value; },
      state: async () => resultValue(await ledger.read(callId, scope)),
      close: async () => { session?.dispose(); await rm(folder, { recursive: true, force: true }); },
    };
  } catch (error) { session?.dispose(); await rm(folder, { recursive: true, force: true }); throw error; }
}
