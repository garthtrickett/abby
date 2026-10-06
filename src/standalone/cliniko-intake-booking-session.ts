import { ClinikoBookingWriter } from "../cliniko/booking-write.ts";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import type { BookingEvidenceHost, BookingMenuHost, BookingMenuQuery, IntakeEvidenceHost, IntakeEvidenceQuery, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { HostMutation, HostWriteReceipt, LocationScope, Result, StaffItem } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoBookingHost } from "./cliniko-booking-host.ts";
import { ClinikoBookingMenu } from "./cliniko-booking-menu.ts";
import { ClinikoBookingOffers } from "./cliniko-booking-offers.ts";
import { ClinikoIntakeSession } from "./cliniko-intake-session.ts";
import type { ClinikoIntakeSessionConfig } from "./cliniko-intake-session.ts";
import type { PatientVerificationPermission } from "./email-patient-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { IntakeBookingProof } from "./intake-booking-proof.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import { OwnerFileBookingPolicy } from "./owner-file-booking-policy.ts";

export type ClinikoIntakeBookingSessionConfig = Omit<ClinikoIntakeSessionConfig, "ledger" | "cliniko" | "policies"> & Readonly<{
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
  readonly #offers: ClinikoBookingOffers;
  readonly #menu: ClinikoBookingMenu;
  readonly #booking: ClinikoBookingHost;
  readonly #signal: AbortSignal;
  readonly #onClose = () => this.dispose();
  private constructor(intake: ClinikoIntakeSession, proof: IntakeBookingProof, offers: ClinikoBookingOffers,
    menu: ClinikoBookingMenu, booking: ClinikoBookingHost, signal: AbortSignal) {
    super(); this.intake = intake; this.#proof = proof; this.#offers = offers; this.#menu = menu; this.#booking = booking; this.#signal = signal;
    signal.addEventListener("abort", this.#onClose, { once: true }); if (signal.aborted) this.dispose();
  }
  static async create(incoming: ClinikoIntakeBookingSessionConfig): Promise<Result<ClinikoIntakeBookingSession, Failure>> {
    const denied = (): Result<ClinikoIntakeBookingSession, Failure> => err({ kind: "intakeBookingSessionUnavailable" });
    let intake: ClinikoIntakeSession | undefined, proof: IntakeBookingProof | undefined, offers: ClinikoBookingOffers | undefined;
    let menu: ClinikoBookingMenu | undefined, booking: ClinikoBookingHost | undefined, completed = false;
    let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => { booking?.dispose(); menu?.dispose(); offers?.dispose(); proof?.dispose(); intake?.dispose(); };
    try {
      if (!incoming || !(incoming.signal instanceof AbortSignal) || incoming.signal.aborted || typeof incoming.bookingPermission?.allows !== "function" ||
          (incoming.timeoutMs !== undefined && (!Number.isSafeInteger(incoming.timeoutMs) || incoming.timeoutMs < 1 || incoming.timeoutMs > 20_000))) return denied();
      const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound),
        cliniko: Object.freeze({ ...incoming.cliniko }), clock: incoming.clock ?? (() => new Date().toISOString()) });
      const binding = config.policy.binding(), scope = config.receipt.scope;
      if (binding.businessId !== config.cliniko.businessId || binding.timeZone !== config.cliniko.timeZone || binding.countryCallingCode !== config.cliniko.countryCallingCode) return denied();
      controller = new AbortController(); timer = setTimeout(() => controller!.abort(), config.timeoutMs ?? 15_000);
      const signal = AbortSignal.any([config.signal, controller.signal]);
      const build = (async () => {
        const terms = await OwnerFileBookingPolicy.capture({ ...config.cliniko, scope, path: config.bookingApprovalPath, directory: config.directory,
          policyVersion: config.policyVersion, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), clock: config.clock });
        if (!terms.ok || signal.aborted) return undefined;
        const registration = await ClinikoIntakeSession.create({ ...config, signal: config.signal });
        if (!registration.ok) return undefined;
        intake = registration.value; if (signal.aborted) { dispose(); return undefined; }
        const policy = { current: async (bound: LocationScope) => {
          const approval = await terms.value.current(bound), current = await config.policies.read(bound), state = await config.ledger.read(config.receipt.callId, bound);
          return ok({ scope: bound, version: config.policyVersion, enabled: !config.signal.aborted && approval.ok && current.ok && state.ok &&
            current.value.policyVersion === config.policyVersion && current.value.automationEnabled && current.value.bookingEnabled && current.value.staffWorkEnabled === true && current.value.capabilities.book === "execute" &&
            state.value.policy.automationEnabled && state.value.policy.bookingEnabled && state.value.policy.staffWorkEnabled === true && state.value.policy.capabilities.book === "execute" });
        } };
        proof = new IntakeBookingProof({ intake, scope, callId: config.receipt.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
          presentedCallerNumber: config.inbound.presentedCallerNumber!, contact: new ClinikoVerificationContactReader({ ...config.cliniko, scope }, config.fetchPort),
          permission: config.bookingPermission, policy, signal: config.signal, clock: config.clock,
          ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) });
        const selection = ClinikoBookingOffers.create({ ...config.cliniko, scope, callId: config.receipt.callId, sessionId: config.sessionId,
          policyVersion: config.policyVersion, proof: proof.proof, policy: terms.value, clock: config.clock,
          ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) }, config.fetchPort);
        const writer = ClinikoBookingWriter.create({ ...config.cliniko, scope }, config.fetchPort, config.clock);
        const recall = ClinikoRecallWriter.create({ ...config.cliniko, scope }, config.fetchPort);
        if (!selection.ok || !writer.ok || !recall.ok || signal.aborted) return undefined;
        offers = selection.value; menu = new ClinikoBookingMenu({ verification: proof, offers, scope, callId: config.receipt.callId,
          sessionId: config.sessionId, policyVersion: config.policyVersion });
        booking = new ClinikoBookingHost({ ...config.cliniko, scope, callId: config.receipt.callId, sessionId: config.sessionId,
          policyVersion: config.policyVersion, ledger: config.ledger, policy: config.policies, proof: proof.proof, authority: offers, menu,
          writer: writer.value, recallWriter: recall.value, clock: config.clock });
        if (signal.aborted) return undefined;
        return new ClinikoIntakeBookingSession(intake, proof, offers, menu, booking, config.signal);
      })().catch(() => undefined).finally(() => { if (signal.aborted) dispose(); });
      const result = await awaitUntilAbort(build, signal);
      if (!result || signal.aborted) return denied();
      completed = true; return ok(result);
    } catch { return denied(); }
    finally { if (timer) clearTimeout(timer); if (!completed) { controller?.abort(); dispose(); } }
  }
  resolveIntake(query: IntakeEvidenceQuery) { return this.intake.resolveIntake(query); }
  resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string, signal?: AbortSignal) {
    return this.#booking.resolveBooking(scope, verificationRef, offerRef, now, signal);
  }
  bookingMenuAvailable(): boolean { return this.#booking.bookingMenuAvailable(); }
  readBookingMenu(query: BookingMenuQuery & Readonly<{ from: string; to: string }>) { return this.#booking.readBookingMenu(query); }
  selectBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>) { return this.#booking.selectBookingMenu(query); }
  correctBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; startsAt: string }>) { return this.#booking.correctBookingMenu(query); }
  write(mutation: HostMutation, now: string, signal?: AbortSignal): Promise<HostWriteReceipt> {
    return mutation.kind === "intake" ? this.intake.write(mutation, now, signal) : this.#booking.write(mutation, now, signal);
  }
  reconcile(mutation: HostMutation) { return mutation.kind === "intake" ? this.intake.reconcile(mutation) : this.#booking.reconcile(mutation); }
  openTask(item: StaffItem) { return this.intake.openTask(item); }
  reconcileTask(item: StaffItem) { return this.intake.reconcileTask(item); }
  dispose(): void {
    this.#signal.removeEventListener("abort", this.#onClose); this.#booking.dispose(); this.#menu.dispose(); this.#offers.dispose(); this.#proof.dispose(); this.intake.dispose();
  }
}
