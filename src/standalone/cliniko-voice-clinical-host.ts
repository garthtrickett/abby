import { callIdFor } from "../voice/admission.ts";
import { captureBookingMemoConfig } from "./cliniko-booking-memo.ts";
import { captureFinancialVoiceProvision, financialVoiceForCall } from "./financial-voice-provision.ts";
import type { FinancialVoiceProvision } from "./financial-voice-provision.ts";
export type { FinancialVoiceProvision } from "./financial-voice-provision.ts";
import { captureConfirmationResendPolicy } from "./capture-confirmation-resend-policy.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { ClinikoSelectionApproval } from "../cliniko/catalogue-setup.ts";
import type { ApprovedGreeting, LocationScope } from "../core/model.ts";
import { err } from "../core/model.ts";
import type { PolicyStore } from "../core/host.ts";
import { validGreetingShape } from "../core/greeting.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { ClinikoCallFlow } from "./cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "./cliniko-call-flow.ts";
import type { ClinikoVoiceWorkflow } from "./transient-voice-composition.ts";

type CallOwned = "receipt" | "inbound" | "sessionId" | "ledger" | "signal" | "clock";
export type ClinikoVoiceClinicalHostConfig = Omit<ClinikoCallFlowConfig, CallOwned | "intake" | "correction" | "resend" | "financial"> & Readonly<{
  scope: LocationScope;
  greeting: ApprovedGreeting;
  /** The admitted call supplies private playback; no shared/static receipt port. */
  financial?: FinancialVoiceProvision;
  intake?: Omit<NonNullable<ClinikoCallFlowConfig["intake"]>, "presentation">;
  resend?: Omit<NonNullable<ClinikoCallFlowConfig["resend"]>, "presentation">;
  correction?: Omit<NonNullable<ClinikoCallFlowConfig["correction"]>, "presentation">;
  intent: ClinikoVoiceWorkflow["intent"];
  privateIntakeTranscription?: ClinikoVoiceWorkflow["privateIntakeTranscription"];
  privateCorrectionTranscription?: ClinikoVoiceWorkflow["privateCorrectionTranscription"];
  privateRepresentativeTranscription?: ClinikoVoiceWorkflow["privateRepresentativeTranscription"];
}>;

/** Clinic-owned clinical composition. A catalogue approval remains read-only:
 * each session still checks separate caller, operation, policy and review authority.
 * This host cannot change admission readiness or manufacture a verification result. */
export class ClinikoVoiceClinicalHost {
  readonly #config: ClinikoVoiceClinicalHostConfig;
  readonly #financialPolicies = new WeakSet<object>();
  constructor(config: ClinikoVoiceClinicalHostConfig) {
    if (!validGreetingShape(config.greeting, config.scope) || typeof config.intent !== "function" ||
        config.correction && typeof config.privateCorrectionTranscription !== "function" ||
        config.representativeInput && typeof config.privateRepresentativeTranscription !== "function") {
      throw new RangeError("invalid clinical voice host");
    }
    const financialProvision = config.financial ? captureFinancialVoiceProvision(config.financial, { scope: config.scope, ...config.cliniko }) : undefined;
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }),
      ...(config.memo ? { memo: captureBookingMemoConfig(config.memo, { scope: config.scope, ...config.cliniko,
        credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey) }) } : {}),
      ...(financialProvision ? { financial: financialProvision } : {}),
      greeting: Object.freeze(structuredClone(config.greeting)), cliniko: Object.freeze({ ...config.cliniko }),
      approvals: Object.freeze({ ...config.approvals }),
      ...(config.classAttendance ? { classAttendance: Object.freeze({ ...config.classAttendance }) } : {}),
      ...(config.classServices ? { classServices: Object.freeze(config.classServices.map(service => Object.freeze({ ...service }))) } : {}),
      ...(config.reschedulingDestination ? { reschedulingDestination: Object.freeze({ ...config.reschedulingDestination }) } : {}),
      ...(config.reschedulingPractitioners ? { reschedulingPractitioners: Object.freeze(config.reschedulingPractitioners.map(member => Object.freeze({ ...member }))) } : {}),
      ...(config.catalogue ? { catalogue: Object.freeze({ ...config.catalogue,
        practitioners: Object.freeze(config.catalogue.practitioners.map(member => Object.freeze({ ...member }))) }) } : {}),
      ...(config.intake ? { intake: Object.freeze({ ...config.intake }) } : {}),
      ...(config.resend ? { resend: Object.freeze({ ...config.resend }) } : {}),
      ...(config.representativeInput ? { representativeInput: Object.freeze({ ...config.representativeInput }) } : {}),
      ...(config.correction ? { correction: Object.freeze({ ...config.correction }) } : {}),
      ...(config.staff ? { staff: Object.freeze({ ...config.staff }) } : {}),
      ...(config.enquiry ? { enquiry: Object.freeze({ ...config.enquiry }) } : {}),
      ...(config.history ? { history: Object.freeze({ ...config.history }) } : {}),
      ...(config.serviceCatalogue ? { serviceCatalogue: Object.freeze({ ...config.serviceCatalogue,
        services: Object.freeze(config.serviceCatalogue.services.map(service => Object.freeze({ ...service,
          practitioners: Object.freeze(service.practitioners.map(member => Object.freeze({ ...member }))) }))) }) } : {}) });
  }
  get greeting(): ApprovedGreeting { return structuredClone(this.#config.greeting); }
  get locationServiceSource() {
    const c = this.#config;
    return c.serviceCatalogue ? Object.freeze({ path: c.serviceCatalogue.approvalPath, scope: c.scope, policyVersion: c.policyVersion,
      businessId: c.cliniko.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.cliniko.apiKey), timeZone: c.cliniko.timeZone,
      directory: c.directory }) : undefined;
  }
  get #policies(): PolicyStore {
    const c = this.#config;
    return new Proxy(c.policies, { get(target, key) {
      if (key === "read") return async (...args: Parameters<PolicyStore["read"]>) => {
        const loaded = await target.read(...args);
        return loaded.ok ? { ok: true as const, value: await captureConfirmationResendPolicy(loaded.value, c.resend?.policy) } : loaded;
      };
      const value = Reflect.get(target, key) as unknown; return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  get cataloguePolicy(): Pick<PolicyStore, "read"> {
    return { read: scope => sameScope(scope, this.#config.scope) ? this.#policies.read(scope)
      : Promise.resolve(err({ kind: "invalidValue" })) };
  }
  usesBudget(budget: ClinikoRequestBudget): boolean { return this.#config.cliniko.rateBudget === budget; }

  /** Runner-owned shared revocation store; caller and model inputs cannot select it. */
  withContactRevision(owner: import("../cliniko/contact-revision.ts").ClinikoContactRevisionReader): ClinikoVoiceClinicalHost {
    if (!owner.matches(this.#config.scope.tenantId, clinikoCredentialFingerprint(this.#config.cliniko.apiKey)) ||
        this.#config.correction && this.#config.correction.contactRevision !== owner ||
        this.#config.resend && this.#config.resend.contactRevision !== owner) throw new RangeError("contact account mismatch");
    return new ClinikoVoiceClinicalHost({ ...this.#config, cliniko: { ...this.#config.cliniko, contactRevision: owner } });
  }

  /** Rechecked on webhook admission AND stream construction. A changed route,
   * credential, policy, zone or cohort cannot silently reuse this host. */
  matches(approval: ClinikoSelectionApproval): boolean {
    const c = this.#config, p = approval.selection;
    return sameScope(c.scope, approval.scope) && c.policyVersion === p.policyVersion &&
      c.cliniko.businessId === p.businessId && c.cliniko.practitionerId === p.practitionerId &&
      c.cliniko.appointmentTypeId === p.appointmentTypeId && c.cliniko.timeZone === approval.businessTimeZone &&
      clinikoCredentialFingerprint(c.cliniko.apiKey) === approval.credentialFingerprint;
  }
  workflow(approval: ClinikoSelectionApproval): ClinikoVoiceWorkflow {
    if (!this.matches(approval)) throw new RangeError("clinical voice host binding mismatch");
    const c = this.#config;
    const { intake, correction, resend, financial, ...base } = c;
    const usedPolicies = this.#financialPolicies;
    return { policies: this.#policies, ...(c.publicKnowledge ? { publicKnowledge: c.publicKnowledge } : {}),
      ...(c.privateIntakeTranscription ? { privateIntakeTranscription: c.privateIntakeTranscription } : {}),
      ...(c.privateCorrectionTranscription ? { privateCorrectionTranscription: c.privateCorrectionTranscription } : {}),
      ...(c.privateRepresentativeTranscription ? { privateRepresentativeTranscription: c.privateRepresentativeTranscription } : {}),
      intent: c.intent,
      create(context) {
        if (!sameScope(context.receipt.scope, c.scope) || !context.sessionId ||
            context.receipt.callId !== callIdFor(context.inbound.key) ||
            context.receipt.admission.key.accountRef !== context.inbound.key.accountRef ||
            context.receipt.admission.key.providerCallRef !== context.inbound.key.providerCallRef ||
            context.receipt.admission.dialedNumber !== context.inbound.dialedNumber || resend && !context.resendPresentation ||
            financial && typeof context.financialPresentation?.play !== "function") {
          throw new RangeError("clinical voice admission mismatch");
        }
        const provision = financial ? financialVoiceForCall(financial, { scope: c.scope, callId: context.receipt.callId,
          sessionId: context.sessionId, signal: context.signal, clock: context.clock }, context.financialPresentation!, usedPolicies) : undefined;
        const flow = ClinikoCallFlow.create({ ...base, ...context, policyVersion: c.policyVersion,
          ...(provision ? { financial: provision } : {}),
          ...(intake ? { intake: { ...intake, presentation: context.privatePresentation } } : {}),
          ...(correction ? { correction: { ...correction, presentation: context.privatePresentation } } : {}),
          ...(resend ? { resend: { ...resend, presentation: context.resendPresentation! } } : {}) });
        if (!flow.ok) throw new Error("clinical voice workflow unavailable");
        return flow.value;
      } };
  }
}
