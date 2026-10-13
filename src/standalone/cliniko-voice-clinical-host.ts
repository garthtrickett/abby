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
export type ClinikoVoiceClinicalHostConfig = Omit<ClinikoCallFlowConfig, CallOwned | "intake"> & Readonly<{
  scope: LocationScope;
  greeting: ApprovedGreeting;
  intake?: Omit<NonNullable<ClinikoCallFlowConfig["intake"]>, "presentation">;
  intent: ClinikoVoiceWorkflow["intent"];
  privateIntakeTranscription?: ClinikoVoiceWorkflow["privateIntakeTranscription"];
}>;

/** Clinic-owned clinical composition. A catalogue approval remains read-only:
 * each session still checks separate caller, operation, policy and review authority.
 * This host cannot change admission readiness or manufacture a verification result. */
export class ClinikoVoiceClinicalHost {
  readonly #config: ClinikoVoiceClinicalHostConfig;
  constructor(config: ClinikoVoiceClinicalHostConfig) {
    if (!validGreetingShape(config.greeting, config.scope) || typeof config.intent !== "function") {
      throw new RangeError("invalid clinical voice host");
    }
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }),
      greeting: Object.freeze(structuredClone(config.greeting)), cliniko: Object.freeze({ ...config.cliniko }),
      approvals: Object.freeze({ ...config.approvals }),
      ...(config.reschedulingDestination ? { reschedulingDestination: Object.freeze({ ...config.reschedulingDestination }) } : {}),
      ...(config.reschedulingPractitioners ? { reschedulingPractitioners: Object.freeze(config.reschedulingPractitioners.map(member => Object.freeze({ ...member }))) } : {}),
      ...(config.catalogue ? { catalogue: Object.freeze({ ...config.catalogue,
        practitioners: Object.freeze(config.catalogue.practitioners.map(member => Object.freeze({ ...member }))) }) } : {}),
      ...(config.intake ? { intake: Object.freeze({ ...config.intake }) } : {}),
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
  get cataloguePolicy(): Pick<PolicyStore, "read"> {
    return { read: scope => sameScope(scope, this.#config.scope) ? this.#config.policies.read(scope)
      : Promise.resolve(err({ kind: "invalidValue" })) };
  }
  usesBudget(budget: ClinikoRequestBudget): boolean { return this.#config.cliniko.rateBudget === budget; }

  /** Runner-owned shared revocation store; caller and model inputs cannot select it. */
  withContactRevision(owner: import("../cliniko/contact-revision.ts").ClinikoContactRevisionReader): ClinikoVoiceClinicalHost {
    if (!owner.matches(this.#config.scope.tenantId, clinikoCredentialFingerprint(this.#config.cliniko.apiKey))) throw new RangeError("contact account mismatch");
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
    const { intake, ...base } = c;
    return { policies: c.policies, ...(c.publicKnowledge ? { publicKnowledge: c.publicKnowledge } : {}),
      ...(c.privateIntakeTranscription ? { privateIntakeTranscription: c.privateIntakeTranscription } : {}),
      intent: c.intent,
      create(context) {
        if (!sameScope(context.receipt.scope, c.scope)) {
          throw new RangeError("clinical voice admission mismatch");
        }
        const flow = ClinikoCallFlow.create({ ...base, ...context, policyVersion: c.policyVersion,
          ...(intake ? { intake: { ...intake, presentation: context.privatePresentation } } : {}) });
        if (!flow.ok) throw new Error("clinical voice workflow unavailable");
        return flow.value;
      } };
  }
}
