import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { ClinikoPatientCorrectionSession } from "./cliniko-patient-correction-session.ts";
import { ClinikoReviewedSend } from "./cliniko-reviewed-send.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import type { PatientCorrectionSessionConfig } from "./cliniko-patient-correction-session.ts";

export type PatientCorrectionWorkflowConfig = Pick<PatientCorrectionSessionConfig, "policy" | "permission" | "contactRevision" | "presentation"> &
  Readonly<{ callerApprovalPath: string }>;
type Config = Omit<ClinikoBookingSessionConfig, "representative"> & Readonly<{ correction: PatientCorrectionWorkflowConfig }>;
type Failure = Readonly<{ kind: "patientCorrectionWorkflowUnavailable" }>;

/** Admission-owned composition: independent caller policy, registered-channel proof,
 * correction policy, durable account owner and native review precede any patient PATCH. */
export class ClinikoPatientCorrectionWorkflow {
  readonly #verification: CallerVerificationSession;
  readonly correction: ClinikoPatientCorrectionSession;
  private constructor(verification: CallerVerificationSession, correction: ClinikoPatientCorrectionSession) {
    this.#verification = verification; this.correction = correction;
  }
  static async create(config: Config): Promise<Result<ClinikoPatientCorrectionWorkflow, Failure>> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
    const signal = AbortSignal.any([controller.signal, config.signal]);
    let verification: CallerVerificationSession | undefined, correction: ClinikoPatientCorrectionSession | undefined;
    let published = false;
    try {
      const build = async () => {
        const c = config.correction, scope = config.receipt.scope, clock = config.clock ?? (() => new Date().toISOString());
        if (config.cliniko.contactRevision !== c.contactRevision || !c.contactRevision.matches(scope.tenantId, clinikoCredentialFingerprint(config.cliniko.apiKey))) return undefined;
        const caller = await OwnerFileCallerPolicy.capture({ path: c.callerApprovalPath, scope, policyVersion: config.policyVersion,
          operation: "patients.update", directory: config.directory, clock });
        if (!caller.ok || signal.aborted) return undefined;
        const verificationPolicy = { operation: "patients.update" as const, current: async (bound: typeof scope) => {
          const method = await caller.value.current(bound), terms = await c.policy.current(bound), current = await config.policies.read(bound);
          return method.ok ? ok({ ...method.value, enabled: method.value.enabled && terms.ok && current.ok &&
            current.value.policyVersion === config.policyVersion && current.value.capabilities.patientUpdate === "execute" &&
            current.value.patientCorrectionsEnabled === true && current.value.patientCorrectionsVersion === c.policy.binding().correctionVersion }) : method;
        } };
        const verifier = CallerVerificationSession.create({ receipt: config.receipt, inbound: config.inbound, sessionId: config.sessionId,
          policyVersion: config.policyVersion, operation: "patients.update", ledger: config.ledger, policyStore: config.policies,
          policy: verificationPolicy, lookup: config.lookup,
          contact: new ClinikoVerificationContactReader({ ...config.cliniko, scope }, config.fetchPort), permission: c.permission,
          budget: config.verificationBudget, delivery: config.delivery, clock });
        if (!verifier.ok || signal.aborted) { if (verifier.ok) verifier.value.dispose(); return undefined; }
        verification = verifier.value;
        const recalls = ClinikoRecallWriter.create({ ...config.cliniko, scope }, config.fetchPort);
        if (!recalls.ok || signal.aborted) return undefined;
        const reviewedSend = new ClinikoReviewedSend({ scope, businessId: config.cliniko.businessId,
          credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), policyVersion: config.policyVersion,
          timeZone: config.cliniko.timeZone, recallTypeId: config.cliniko.recallTypeId, writer: recalls.value, clock: () => Date.parse(clock()) });
        const created = await ClinikoPatientCorrectionSession.create({ ...config, ...c, verification, reviewedSend,
          signal: config.signal, ...(config.fetchPort ? { fetchPort: config.fetchPort } : {}), clock });
        if (!created.ok) return undefined;
        correction = created.value;
        if (signal.aborted) { correction.dispose(); return undefined; }
        return new ClinikoPatientCorrectionWorkflow(verification, correction);
      };
      const pending = build().catch(() => undefined);
      const result = await awaitUntilAbort(pending, signal);
      if (!result || signal.aborted) {
        void pending.then(late => late?.dispose());
        return err({ kind: "patientCorrectionWorkflowUnavailable" });
      }
      published = true; return ok(result);
    } catch { return err({ kind: "patientCorrectionWorkflowUnavailable" }); }
    finally { clearTimeout(timer); controller.abort(); if (!published) { correction?.dispose(); verification?.dispose(); } }
  }
  beginVerification() { return this.#verification.begin(); }
  submitCode(code: string) { return this.#verification.submitCode(code); }
  get effects() { return this.correction; }
  dispose(): void { this.correction.dispose(); this.#verification.dispose(); }
}
