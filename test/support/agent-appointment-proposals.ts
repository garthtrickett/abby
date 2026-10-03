import assert from "node:assert/strict";
import type { EffectCallLeaseStore } from "../../src/core/effect-call-lease.ts";
import type { AppointmentChangeEvidenceQuery, IntakeEvidenceQuery, PolicyStore } from "../../src/core/host.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import type { HostMutation, HostWriteReceipt, LocationScope, Result } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { GatewayCommand } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { DisabledStandaloneHost } from "../../src/standalone/disabled-host.ts";
import { approvedSyntheticPolicy } from "./approved-voice.ts";

export const proposalNow = "2026-10-03T10:00:00.000Z";
const expiry = "2026-10-03T11:00:00.000Z";
export const proposalCanaries = ["private-agent-patient", "private-agent-proof", "private-agent-appointment",
  "private-agent-caller-text", "private-agent-consent", "private-agent-draft"];
export type ProposalOperation = "cancel" | "reschedule" | "intake";
export type ProposalCommand = Extract<GatewayCommand, { kind: "appointments.change.propose.v1" | "patients.intake.propose.v1" }>;
export const proposalReady = async () => ok(true as const);

export function resultValue<T>(result: Result<T, { kind: string }>): T {
  if (!result.ok) assert.fail(result.error.kind);
  return result.value;
}

class ProposalHost extends ReferenceClinicHost {
  readonly expected = new Map<string, { sessionId: string; policyVersion: string }>();
  readonly writes: HostMutation[] = [];
  evidenceReads = 0;
  unavailable = false;
  private readonly location: LocationScope;
  constructor(scope: LocationScope) { super([], []); this.location = scope; }
  private allowed(query: AppointmentChangeEvidenceQuery | IntakeEvidenceQuery): boolean {
    const expected = this.expected.get(query.callId);
    return !!expected && query.scope.tenantId === this.location.tenantId && query.scope.clinicId === this.location.clinicId &&
      query.scope.locationId === this.location.locationId && expected.sessionId === query.sessionId &&
      expected.policyVersion === query.policyVersion && query.now === proposalNow;
  }
  async resolveAppointmentChange(query: AppointmentChangeEvidenceQuery) {
    this.evidenceReads += 1;
    if (this.unavailable || !this.allowed(query) || query.verificationRef !== proposalCanaries[1] ||
        query.targetRef !== "approved-target" || (query.kind === "reschedule" && query.offerRef !== "approved-offer")) {
      return err({ kind: "unavailable" as const, target: "appointment" as const });
    }
    const patient = { scope: this.location, patientRef: proposalCanaries[0]!, verificationRef: proposalCanaries[1]!, expiresAt: expiry };
    const target = { scope: this.location, patientRef: patient.patientRef, appointmentRef: proposalCanaries[2]!,
      startsAt: "2026-10-08T10:00:00.000Z", endsAt: "2026-10-08T10:30:00.000Z", timeZone: "Etc/UTC" };
    const terms = { version: "terms-v1", approvedText: "No fee applies.", expiresAt: expiry };
    return query.kind === "cancel" ? ok({ kind: "cancel" as const, patient, target, terms })
      : ok({ kind: "reschedule" as const, patient, target, terms, offer: { scope: this.location,
        offerRef: query.offerRef, serviceRef: "service", startsAt: "2026-10-09T10:00:00.000Z", expiresAt: expiry } });
  }
  async resolveIntake(query: IntakeEvidenceQuery) {
    this.evidenceReads += 1;
    return this.unavailable || !this.allowed(query) || query.draftRef !== proposalCanaries[5]
      ? err({ kind: "unavailable" as const, target: "patient" as const })
      : ok({ kind: "intake" as const, scope: this.location, approvedDraftRef: query.draftRef,
        consentRef: proposalCanaries[4]!, duplicateCheckRef: "approved-duplicate-check" });
  }
  override async write(mutation: HostMutation): Promise<HostWriteReceipt> {
    this.writes.push(mutation);
    return { kind: "committed", actionKey: mutation.actionKey, hostRef: `synthetic-${mutation.kind}` };
  }
}

/** Both storage modes cross the same gateway, admission, caller-confirmation and effect interfaces. */
export function proposalHarness(scope: LocationScope, mode: "standalone" | "embedded",
  storage?: { ledger: LedgerStore & EffectCallLeaseStore; policy: PolicyStore }) {
  const hostMode = mode === "embedded" ? "execute" : "unavailable";
  const ledger = storage?.ledger ?? new MemoryLedger(proposalReady);
  const policy = storage?.policy ?? new MemoryPolicyStore("execute", () => proposalNow, proposalReady,
    { cancellation: hostMode, rescheduling: hostMode, intake: hostMode });
  const host = new ProposalHost(scope);
  const reception = new TextReception(ledger, policy, mode === "embedded" ? host : new DisabledStandaloneHost());
  const runtime = new CallRuntime(ledger, scope);
  const gateway = (role: "agent" | "clinicAdmin", location = scope) => new CommandGateway({ actorRef: `trusted-${role}`,
    role, scope: location }, policy, reception, undefined, undefined, undefined, ledger);
  const agent = gateway("agent"), admin = gateway("clinicAdmin");
  async function enable(): Promise<void> {
    resultValue(await admin.submit({ kind: "settings.automation.enabled.change.v1", expectedVersion: "0", enabled: true }));
    resultValue(await admin.submit({ kind: "settings.appointments.cancellation.enabled.change.v1", expectedVersion: "0", enabled: true }));
    resultValue(await admin.submit({ kind: "settings.appointments.rescheduling.enabled.change.v1", expectedVersion: "1", enabled: true }));
    resultValue(await admin.submit({ kind: "settings.patients.firstTimeIntake.enabled.change.v1", expectedVersion: "0", enabled: true }));
  }
  async function admit(operation: ProposalOperation, suffix = "first"): Promise<ProposalCommand> {
    const callId = `${scope.tenantId}-${operation}-${suffix}`, sessionId = `${callId}-session`;
    const captured = approvedSyntheticPolicy({ ...resultValue(await policy.read(scope)), greeting: {
      scope, version: "synthetic-greeting", ownerRef: "synthetic-owner", approved: true,
      approvedText: "Hello. How can I help you?" } });
    resultValue(await runtime.admit(callId, captured, { key: { accountRef: "synthetic-account", providerCallRef: callId },
      dialedNumber: "+6125550199", acceptedAt: proposalNow, deadline: "2026-10-03T10:00:30.000Z" }));
    resultValue(await runtime.activate(callId, sessionId, proposalNow));
    host.expected.set(callId, { sessionId, policyVersion: captured.policyVersion });
    const turn = { callId, sessionId, turnId: "proposal", text: proposalCanaries[3]!, quality: "clear" as const, at: proposalNow };
    return operation === "intake" ? { kind: "patients.intake.propose.v1", turn, draftRef: proposalCanaries[5]!, now: proposalNow }
      : { kind: "appointments.change.propose.v1", turn, now: proposalNow,
        selection: operation === "cancel" ? { kind: "cancel", verificationRef: proposalCanaries[1]!, targetRef: "approved-target" }
          : { kind: "reschedule", verificationRef: proposalCanaries[1]!, targetRef: "approved-target", offerRef: "approved-offer" } };
  }
  return { scope, mode, ledger, policy, host, reception, runtime, agent, admin, gateway, enable, admit };
}
