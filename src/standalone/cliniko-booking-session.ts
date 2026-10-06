import { OwnerFileBookingCatalogue } from "./owner-file-booking-catalogue.ts";
import { ClinikoCatalogueBookingHost } from "./cliniko-catalogue-booking-host.ts";
import { catalogueBookingAuthority } from "./catalogue-booking-member.ts";
import { ClinikoBookingMenu } from "./cliniko-booking-menu.ts";
import { ClinikoBookingWriter } from "../cliniko/booking-write.ts";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import { clinikoCredentialFingerprint, isClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import type { PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, Result } from "../core/model.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import type { CallerCandidateLookup } from "../voice/caller-candidates.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { ClinikoBookingOffers } from "./cliniko-booking-offers.ts";
import { ClinikoBookingHost } from "./cliniko-booking-host.ts";
import type { PatientCodeDelivery, PatientVerificationBudget, PatientVerificationPermission } from "./email-patient-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";
import { OwnerFileBookingPolicy } from "./owner-file-booking-policy.ts";

export type ClinikoBookingSessionConfig = Readonly<{
  receipt: AdmissionReceipt; inbound: AuthenticatedInboundCall; sessionId: string; policyVersion: string;
  ledger: LedgerStore; policies: PolicyStore; lookup: CallerCandidateLookup;
  permission: PatientVerificationPermission; verificationBudget: PatientVerificationBudget; delivery: PatientCodeDelivery;
  directory: AdminDirectory; callerApprovalPath: string; bookingApprovalPath: string;
  cliniko: Readonly<{ apiKey: string; contactEmail: string; businessId: string; practitionerId: string; appointmentTypeId: string; recallTypeId: string;
    timeZone: string; countryCallingCode: string; rateBudget: ClinikoRequestBudget }>;
  catalogue?: Readonly<{ approvalPath: string; practitioners: readonly Readonly<{ practitionerId: string; bookingApprovalPath: string }>[] }>;
  signal: AbortSignal; fetchPort?: typeof fetch; clock?: () => string; timeoutMs?: number;
}>;
type Failure = Readonly<{ kind: "bookingSessionUnavailable" }>;

/** Trusted post-admission wiring. One admission owns one verifier, selection map and send attempt.
 * These ports belong to the call owner, never to a model/caller or an activation endpoint. */
export class ClinikoBookingSession {
  readonly #verification: CallerVerificationSession;
  readonly #authority: ClinikoBookingOffers;
  readonly #host: ClinikoBookingHost | ClinikoCatalogueBookingHost;
  readonly #extra: readonly Readonly<{ dispose(): void }>[];
  readonly #signal: AbortSignal;
  readonly #menu: ClinikoBookingMenu;
  readonly #onClose = () => this.dispose();
  #closed = false;
  private constructor(verification: CallerVerificationSession, authority: ClinikoBookingOffers,
    host: ClinikoBookingHost | ClinikoCatalogueBookingHost, menu: ClinikoBookingMenu, signal: AbortSignal, extra: readonly Readonly<{ dispose(): void }>[]) {
    this.#verification = verification; this.#authority = authority; this.#host = host; this.#signal = signal; this.#menu = menu; this.#extra = [...extra];
    signal.addEventListener("abort", this.#onClose, { once: true });
    if (signal.aborted) this.dispose();
  }

  static async create(incoming: ClinikoBookingSessionConfig): Promise<Result<ClinikoBookingSession, Failure>> {
    const unavailable = (): Result<ClinikoBookingSession, Failure> => err({ kind: "bookingSessionUnavailable" });
    let timeout: ReturnType<typeof setTimeout> | undefined, removeAbort: () => void = () => undefined;
    let verification: CallerVerificationSession | undefined, authority: ClinikoBookingOffers | undefined;
    let host: ClinikoBookingHost | ClinikoCatalogueBookingHost | undefined, completed: ClinikoBookingSession | undefined;
    let menu: ClinikoBookingMenu | undefined;
    const extra: Readonly<{ dispose(): void }>[] = [];
    let settled = false;
    const dispose = () => { host?.dispose(); menu?.dispose(); authority?.dispose(); for (const resource of extra) resource.dispose(); verification?.dispose(); };
    try {
      if (!incoming || !(incoming.signal instanceof AbortSignal) || incoming.signal.aborted ||
          !isClinikoRequestBudget(incoming.cliniko?.rateBudget) ||
          (incoming.timeoutMs !== undefined && (!Number.isSafeInteger(incoming.timeoutMs) || incoming.timeoutMs < 1 || incoming.timeoutMs > 20_000))) return unavailable();
      // Freeze caller/provider bindings before the first async approval read.
      const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound),
        cliniko: Object.freeze({ ...incoming.cliniko }),
        ...(incoming.catalogue ? { catalogue: Object.freeze({ ...incoming.catalogue, practitioners: Object.freeze(incoming.catalogue.practitioners.map(member => Object.freeze({ ...member }))) }) } : {}), clock: incoming.clock ?? (() => new Date().toISOString()) });
      const scope = config.receipt.scope, fetchPort = config.fetchPort ?? fetch;
      const stopped = new Promise<undefined>(resolve => {
        const abort = () => { settled = true; dispose(); completed?.dispose(); resolve(undefined); };
        config.signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => config.signal.removeEventListener("abort", abort);
        timeout = setTimeout(abort, config.timeoutMs ?? 15_000);
        if (config.signal.aborted) abort();
      });
      const active = async () => {
        const state = await config.ledger.read(config.receipt.callId, scope), at = Date.parse(config.clock());
        return state.ok && Number.isFinite(at) && state.value.lifecycle === "active" &&
          state.value.admission?.key.accountRef === config.receipt.admission.key.accountRef &&
          state.value.admission?.key.providerCallRef === config.receipt.admission.key.providerCallRef &&
          state.value.sessionLease?.sessionId === config.sessionId && Date.parse(state.value.sessionLease.expiresAt) > at &&
          state.value.policy.policyVersion === config.policyVersion;
      };
      const build = (async () => {
        if (!await active() || settled) return undefined;
        const caller = await OwnerFileCallerPolicy.capture({ path: config.callerApprovalPath, scope, policyVersion: config.policyVersion,
          operation: "appointments.book", directory: config.directory, clock: config.clock });
        if (!caller.ok || settled) return undefined;
        const policy = await OwnerFileBookingPolicy.capture({ path: config.bookingApprovalPath, scope,
          policyVersion: config.policyVersion, businessId: config.cliniko.businessId, practitionerId: config.cliniko.practitionerId, appointmentTypeId: config.cliniko.appointmentTypeId, recallTypeId: config.cliniko.recallTypeId,
          credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), timeZone: config.cliniko.timeZone,
          directory: config.directory, clock: config.clock });
        if (!policy.ok || settled) return undefined;
        const catalogue = config.catalogue ? await OwnerFileBookingCatalogue.capture({ path: config.catalogue.approvalPath, scope,
          policyVersion: config.policyVersion, businessId: config.cliniko.businessId, appointmentTypeId: config.cliniko.appointmentTypeId,
          credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), timeZone: config.cliniko.timeZone, directory: config.directory, clock: config.clock }) : undefined;
        if (config.catalogue && (!catalogue?.ok || settled)) return undefined;
        const profile = catalogue?.ok ? await catalogue.value.current(scope) : undefined;
        if (config.catalogue && (!profile?.ok || profile.value.practitioners[0]?.practitionerId !== config.cliniko.practitionerId ||
            config.catalogue.practitioners.length !== profile.value.practitioners.length ||
            config.catalogue.practitioners.some((member, index) => member.practitionerId !== profile.value.practitioners[index]?.practitionerId ||
              typeof member.bookingApprovalPath !== "string" || !member.bookingApprovalPath.trim()) ||
            config.catalogue.practitioners[0]?.bookingApprovalPath !== config.bookingApprovalPath)) return undefined;
        const verificationPolicy = { operation: "appointments.book" as const, current: async (bound: typeof scope) => {
          const method = await caller.value.current(bound);
          if (!method.ok) return method;
          const terms = catalogue?.ok ? await catalogue.value.current(bound) : await policy.value.current(bound);
          const current = await config.policies.read(bound);
          const admitted = await config.ledger.read(config.receipt.callId, bound);
          return ok({ ...method.value, enabled: method.value.enabled && terms.ok && current.ok &&
            current.value.policyVersion === config.policyVersion && current.value.bookingEnabled === true &&
            current.value.capabilities.book === "execute" && current.value.staffWorkEnabled === true && admitted.ok &&
            admitted.value.policy.capabilities.book === "execute" && admitted.value.policy.staffWorkEnabled === true });
        } };
        const session = CallerVerificationSession.create({ receipt: config.receipt, inbound: config.inbound, sessionId: config.sessionId,
          policyVersion: config.policyVersion, operation: "appointments.book", ledger: config.ledger, policyStore: config.policies,
          policy: verificationPolicy, lookup: config.lookup, contact: new ClinikoVerificationContactReader({ ...config.cliniko, scope }, fetchPort),
          permission: config.permission, budget: config.verificationBudget, delivery: config.delivery, clock: config.clock, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) });
        if (!session.ok || settled) return undefined;
        verification = session.value;
        const source = ClinikoBookingOffers.create({ ...config.cliniko, scope, callId: config.receipt.callId,
          sessionId: config.sessionId, policyVersion: config.policyVersion, proof: verification.proof,
          policy: policy.value, clock: config.clock, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) }, fetchPort);
        const booking = ClinikoBookingWriter.create({ ...config.cliniko, scope }, fetchPort, config.clock);
        const recalls = ClinikoRecallWriter.create({ ...config.cliniko, scope }, fetchPort);
        if (!source.ok || !booking.ok || !recalls.ok || settled) return undefined;
        authority = source.value;
        menu = new ClinikoBookingMenu({ verification, offers: authority, scope, callId: config.receipt.callId, sessionId: config.sessionId, policyVersion: config.policyVersion });
        host = new ClinikoBookingHost({ scope, callId: config.receipt.callId, sessionId: config.sessionId,
          policyVersion: config.policyVersion, ledger: config.ledger, policy: config.policies, proof: verification.proof, authority: catalogue?.ok ? catalogueBookingAuthority(authority, catalogue.value, scope, config.cliniko.practitionerId) : authority,
          menu,
          timeZone: config.cliniko.timeZone, recallTypeId: config.cliniko.recallTypeId, writer: booking.value,
          recallWriter: recalls.value, clock: config.clock });
        if (config.catalogue && catalogue?.ok && profile?.ok) {
          const members = [{ practitionerId: config.cliniko.practitionerId, name: profile.value.practitioners[0]!.name, host }];
          for (const [index, member] of config.catalogue.practitioners.entries()) {
            if (index === 0) continue;
            const selection = { ...config.cliniko, practitionerId: member.practitionerId };
            const terms = await OwnerFileBookingPolicy.capture({ path: member.bookingApprovalPath, scope,
              policyVersion: config.policyVersion, ...selection, credentialFingerprint: clinikoCredentialFingerprint(selection.apiKey), directory: config.directory, clock: config.clock });
            if (!terms.ok || settled) return undefined;
            const offers = ClinikoBookingOffers.create({ ...selection, scope, callId: config.receipt.callId, sessionId: config.sessionId,
              policyVersion: config.policyVersion, proof: verification.proof, policy: terms.value, clock: config.clock }, fetchPort);
            const writer = ClinikoBookingWriter.create({ ...selection, scope }, fetchPort, config.clock);
            if (!offers.ok || !writer.ok || settled) return undefined;
            extra.push(offers.value);
            const selectionMenu = new ClinikoBookingMenu({ verification, offers: offers.value, scope, callId: config.receipt.callId,
              sessionId: config.sessionId, policyVersion: config.policyVersion }); extra.push(selectionMenu);
            const selectionHost = new ClinikoBookingHost({ scope, callId: config.receipt.callId, sessionId: config.sessionId,
              policyVersion: config.policyVersion, ledger: config.ledger, policy: config.policies, proof: verification.proof,
              authority: catalogueBookingAuthority(offers.value, catalogue.value, scope, member.practitionerId), menu: selectionMenu,
              timeZone: selection.timeZone, recallTypeId: selection.recallTypeId, writer: writer.value,
              recallWriter: recalls.value, clock: config.clock }); extra.push(selectionHost);
            members.push({ practitionerId: member.practitionerId, name: profile.value.practitioners[index]!.name, host: selectionHost });
          }
          host = new ClinikoCatalogueBookingHost({ scope, callId: config.receipt.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
            ledger: config.ledger, catalogue: catalogue.value, members });
        }
        if (settled || config.signal.aborted || !await active() || settled) return undefined;
        completed = new ClinikoBookingSession(verification, authority, host, menu, config.signal, extra);
        return completed;
      })().catch(() => undefined);
      const result = await Promise.race([build, stopped]);
      if (!result || settled || config.signal.aborted) return unavailable();
      return ok(result);
    } catch { return unavailable(); }
    finally {
      settled = true; if (timeout !== undefined) clearTimeout(timeout); removeAbort();
      if (!completed || completed.#closed) { completed?.dispose(); dispose(); }
    }
  }

  beginVerification(): ReturnType<CallerVerificationSession["begin"]> { return this.#verification.begin(); }
  submitCode(code: string): ReturnType<CallerVerificationSession["submitCode"]> { return this.#verification.submitCode(code); }
  /** Private owner wiring for existing SAM/gateway commands; never send this grant to a model. */
  verified(): ReturnType<CallerVerificationSession["verified"]> { return this.#verification.verified(); }
  get offers(): ClinikoBookingOffers { return this.#authority; }
  get effects(): ClinikoBookingHost | ClinikoCatalogueBookingHost { return this.#host; }
  dispose(): void {
    this.#closed = true; this.#signal.removeEventListener("abort", this.#onClose);
    this.#host.dispose(); this.#menu.dispose(); this.#authority.dispose(); for (const resource of this.#extra) resource.dispose(); this.#verification.dispose();
  }
}
