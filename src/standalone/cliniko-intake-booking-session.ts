import { createApprovedBookingComposition } from "./approved-booking-composition.ts";
import { captureBookingMemoConfig } from "./cliniko-booking-memo.ts";
import type { ApprovedBookingComposition } from "./approved-booking-composition.ts";
import { OwnerFileBookingCatalogue } from "./owner-file-booking-catalogue.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import type { HostEffects, BookingEvidenceHost, BookingMenuHost, BookingMenuQuery, BookingMenuReadQuery, IntakeEvidenceHost, IntakeEvidenceQuery, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { HostMutation, HostWriteReceipt, LocationScope, Result, StaffItem } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoIntakeSession } from "./cliniko-intake-session.ts";
import type { ClinikoIntakeSessionConfig } from "./cliniko-intake-session.ts";
import type { PatientVerificationPermission } from "./email-patient-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { IntakeBookingProof } from "./intake-booking-proof.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import { OwnerFileBookingPolicy } from "./owner-file-booking-policy.ts";

export type ClinikoIntakeBookingSessionConfig = Omit<ClinikoIntakeSessionConfig, "ledger" | "cliniko" | "policies"> & Readonly<{
  financial?: NonNullable<ClinikoBookingSessionConfig["financial"]>;
  memo?: NonNullable<ClinikoBookingSessionConfig["memo"]>;
  catalogue?: NonNullable<ClinikoBookingSessionConfig["catalogue"]>;
  ledger: LedgerStore; policies: PolicyStore; directory: AdminDirectory; bookingApprovalPath: string; bookingPermission: PatientVerificationPermission;
  cliniko: ClinikoIntakeSessionConfig["cliniko"] & Readonly<{ businessId: string; practitionerId: string; appointmentTypeId: string;
    recallTypeId: string; timeZone: string; countryCallingCode: string }>;
}>;
type Failure = Readonly<{ kind: "intakeBookingSessionUnavailable" }>;

/** One admitted call, two separately confirmed actions. Registration cannot auto-book or roll back a patient.
 * Private intake/OTP collection belongs to the trusted owner; existing agent commands own the booking menu and SAM. */
export class ClinikoIntakeBookingSession extends NoStoredKnowledge implements IntakeEvidenceHost, BookingEvidenceHost, BookingMenuHost {
  readonly effectDeadlineMs = 30_000;
  readonly intake: ClinikoIntakeSession;
  readonly #proof: IntakeBookingProof;
  readonly #composition: ApprovedBookingComposition;
  readonly #signal: AbortSignal;
  readonly #onClose = () => this.dispose();
  private constructor(intake: ClinikoIntakeSession, proof: IntakeBookingProof, composition: ApprovedBookingComposition, signal: AbortSignal) {
    super(); this.intake = intake; this.#proof = proof; this.#composition = composition; this.#signal = signal;
    signal.addEventListener("abort", this.#onClose, { once: true }); if (signal.aborted) this.dispose();
  }

  static async create(incoming: ClinikoIntakeBookingSessionConfig): Promise<Result<ClinikoIntakeBookingSession, Failure>> {
    const denied = (): Result<ClinikoIntakeBookingSession, Failure> => err({ kind: "intakeBookingSessionUnavailable" });
    let intake: ClinikoIntakeSession | undefined, proof: IntakeBookingProof | undefined;
    let composition: ApprovedBookingComposition | undefined, completed = false;
    let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => { composition?.dispose(); proof?.dispose(); intake?.dispose(); };
    try {
      if (!incoming || !(incoming.signal instanceof AbortSignal) || incoming.signal.aborted || typeof incoming.bookingPermission?.allows !== "function" ||
          (incoming.timeoutMs !== undefined && (!Number.isSafeInteger(incoming.timeoutMs) || incoming.timeoutMs < 1 || incoming.timeoutMs > 20_000))) return denied();
      const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound),
        cliniko: Object.freeze({ ...incoming.cliniko }),
        ...(incoming.memo ? { memo: captureBookingMemoConfig(incoming.memo, { scope: incoming.receipt.scope, ...incoming.cliniko,
          credentialFingerprint: clinikoCredentialFingerprint(incoming.cliniko.apiKey), ...(incoming.clock ? { clock: incoming.clock } : {}) }) } : {}),
        ...(incoming.catalogue ? { catalogue: Object.freeze({ ...incoming.catalogue, practitioners: Object.freeze(incoming.catalogue.practitioners.map(member => Object.freeze({ ...member }))) }) } : {}), clock: incoming.clock ?? (() => new Date().toISOString()) });
      const binding = config.policy.binding(), scope = config.receipt.scope;
      if (binding.businessId !== config.cliniko.businessId || binding.timeZone !== config.cliniko.timeZone || binding.countryCallingCode !== config.cliniko.countryCallingCode) return denied();
      controller = new AbortController(); timer = setTimeout(() => controller!.abort(), config.timeoutMs ?? 15_000);
      const signal = AbortSignal.any([config.signal, controller.signal]);
      const build = (async () => {
        const terms = await OwnerFileBookingPolicy.capture({ ...config.cliniko, scope, path: config.bookingApprovalPath, directory: config.directory,
          policyVersion: config.policyVersion, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), clock: config.clock,
          ...(config.catalogue?.serviceBinding ? { serviceBinding: config.catalogue.serviceBinding } : {}) });
        if (!terms.ok || signal.aborted) return undefined;
        const catalogue = config.catalogue ? await OwnerFileBookingCatalogue.capture({ path: config.catalogue.approvalPath, scope,
          ...config.cliniko, policyVersion: config.policyVersion, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey),
          directory: config.directory, clock: config.clock, ...(config.catalogue.serviceBinding ? { serviceBinding: config.catalogue.serviceBinding } : {}) }) : undefined;
        if (config.catalogue && (!catalogue?.ok || signal.aborted)) return undefined;
        const workflowApproval = async (check: AbortSignal) => {
          const current = await terms.value.current(scope);
          const group = catalogue?.ok ? await catalogue.value.current(scope) : undefined;
          return !check.aborted && !config.signal.aborted && current.ok && (!config.catalogue || group?.ok === true);
        };
        const registration = await ClinikoIntakeSession.create({ ...config, signal: config.signal,
          ...(config.catalogue ? { workflowApproval } : {}) });
        if (!registration.ok) return undefined;
        intake = registration.value; if (signal.aborted) { dispose(); return undefined; }
        const policy = { current: async (bound: LocationScope) => {
          const approval = await terms.value.current(bound), current = await config.policies.read(bound), state = await config.ledger.read(config.receipt.callId, bound);
          return ok({ scope: bound, version: config.policyVersion, enabled: !config.signal.aborted && approval.ok && await workflowApproval(config.signal) && current.ok && state.ok &&
            current.value.policyVersion === config.policyVersion && current.value.automationEnabled && current.value.bookingEnabled && current.value.staffWorkEnabled === true && current.value.capabilities.book === "execute" &&
            state.value.policy.automationEnabled && state.value.policy.bookingEnabled && state.value.policy.staffWorkEnabled === true && state.value.policy.capabilities.book === "execute" });
        } };
        proof = new IntakeBookingProof({ intake, scope, callId: config.receipt.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
          presentedCallerNumber: config.inbound.presentedCallerNumber!, contact: new ClinikoVerificationContactReader({ ...config.cliniko, scope }, config.fetchPort),
          permission: config.bookingPermission, policy, signal: config.signal, clock: config.clock,
          ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) });
        const result = await createApprovedBookingComposition(config, terms.value, proof, catalogue?.ok ? catalogue.value : undefined,
          () => signal.aborted || config.signal.aborted);
        if (!result.ok) return undefined;
        composition = result.value; if (signal.aborted) return undefined;
        return new ClinikoIntakeBookingSession(intake, proof, composition, config.signal);
      })().catch(() => undefined).finally(() => { if (signal.aborted) dispose(); });
      const result = await awaitUntilAbort(build, signal);
      if (!result || signal.aborted) return denied();
      completed = true; return ok(result);
    } catch { return denied(); }
    finally { if (timer) clearTimeout(timer); if (!completed) { controller?.abort(); dispose(); } }
  }
  get financial() { return this.#composition.host.financial; }
  get effects() { return this.#composition.host; }
  maxBookingSearchDays() { return this.#composition.offers.maxBookingSearchDays(); }
  resolveIntake(query: IntakeEvidenceQuery) { return this.intake.resolveIntake(query); }
  resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string, signal?: AbortSignal) {
    return this.#composition.host.resolveBooking(scope, verificationRef, offerRef, now, signal);
  }
  bookingMenuAvailable(): boolean { return this.#composition.host.bookingMenuAvailable(); }
  readBookingMenu(query: BookingMenuReadQuery) { return this.#composition.host.readBookingMenu(query); }
  selectBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>) { return this.#composition.host.selectBookingMenu(query); }
  correctBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; startsAt: string }>) { return this.#composition.host.correctBookingMenu(query); }
  write(mutation: HostMutation, now: string, signal?: AbortSignal,
    onBookingAcknowledged?: Parameters<HostEffects["write"]>[3]): Promise<HostWriteReceipt> {
    return mutation.kind === "intake" ? this.intake.write(mutation, now, signal) : this.#composition.host.write(mutation, now, signal, onBookingAcknowledged);
  }
  reconcile(mutation: HostMutation) { return mutation.kind === "intake" ? this.intake.reconcile(mutation) : this.#composition.host.reconcile(mutation); }
  openTask(item: StaffItem) { return this.intake.openTask(item); }
  reconcileTask(item: StaffItem) { return this.intake.reconcileTask(item); }
  dispose(): void {
    this.#signal.removeEventListener("abort", this.#onClose); this.#composition.dispose(); this.#proof.dispose(); this.intake.dispose();
  }
}
