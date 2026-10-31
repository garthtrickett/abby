import { ClinikoGuardianContactReader } from "../cliniko/guardian-contact.ts";
import type { ClinicGuardianIdentityRecords } from "../cliniko/guardian-contact.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { inheritClinikoRequestCost } from "../cliniko/request-cost.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import { ok } from "../core/model.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import { ClinikoGuardianSelection } from "./cliniko-guardian-selection.ts";
import { ClinikoRepresentativeSelection } from "./cliniko-representative-selection.ts";
import type { ClinicRepresentativePermission } from "./cliniko-representative-selection.ts";
import type { PatientVerificationPermission } from "./email-patient-authority.ts";
import { GuardianPatientAuthority } from "./guardian-patient-authority.ts";
import type { ClinicGuardianPatientAuthorityRecords } from "./guardian-patient-authority.ts";
import { GuardianVerificationSession } from "./guardian-verification-session.ts";
import { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";
import { OwnerFileGuardianPolicy } from "./owner-file-guardian-policy.ts";
import type { GuardianOperation } from "./owner-file-guardian-policy.ts";
import { OwnerFileRepresentativePolicy } from "./owner-file-representative-policy.ts";

type GuardianRecords = Readonly<{ approvalPath: string; identities: ClinicGuardianIdentityRecords; authorities: ClinicGuardianPatientAuthorityRecords }>;
type NativeInput = Readonly<{ callerApprovalPath: string; callerPermission: PatientVerificationPermission;
  representativeApprovalPath: string; permission: ClinicRepresentativePermission }>;
export type RepresentativeInputConfig = Readonly<{ representativeCallerApprovalPath: string }> &
  (NativeInput & Readonly<{ guardian?: GuardianRecords }> | Readonly<{ guardian: GuardianRecords;
    callerApprovalPath?: never; callerPermission?: never; representativeApprovalPath?: never; permission?: never }>);
export type RepresentativeCallerContext = Pick<ClinikoBookingSessionConfig, "receipt" | "inbound" | "sessionId" | "policyVersion" | "ledger" | "policies" |
  "lookup" | "verificationBudget" | "delivery" | "directory" | "cliniko" | "signal" | "fetchPort" | "clock">;
export type RepresentativeCallerMethod = "clinicPatient" | "guardianRecord";
type Source = Readonly<{ actor: CallerVerificationSession | GuardianVerificationSession; selection: ClinikoRepresentativeSelection | ClinikoGuardianSelection }>;

/** Owns setup and disposal of the two actual private identity sources. Both
 * configured methods must prepare successfully; no failure chooses a fallback.
 * Preparation sends no verification codes and reads no patient/contact identity. */
export class RepresentativeCallerSources {
  readonly #context: RepresentativeCallerContext;
  readonly #input: RepresentativeInputConfig;
  readonly #operation: GuardianOperation;
  readonly #current: () => boolean;
  readonly #sources = new Map<RepresentativeCallerMethod, Source>();
  readonly #allocated = new Set<{ dispose(): void }>();
  readonly #approvals: (() => Promise<boolean>)[] = [];
  readonly #onClose = () => this.dispose();
  #closed = false;
  #prepared = false;
  #attempted = false;
  constructor(input: RepresentativeInputConfig, context: RepresentativeCallerContext, operation: GuardianOperation, current: () => boolean) {
    const native = ["callerApprovalPath", "callerPermission", "representativeApprovalPath", "permission"].some(key => Object.hasOwn(input, key));
    if (typeof input.representativeCallerApprovalPath !== "string" || !input.representativeCallerApprovalPath || !native && !input.guardian ||
        native && (typeof input.callerApprovalPath !== "string" || !input.callerApprovalPath || typeof input.representativeApprovalPath !== "string" ||
          !input.representativeApprovalPath || typeof input.callerPermission?.allows !== "function" || typeof input.permission?.allowsLookup !== "function" ||
          typeof input.permission?.authorize !== "function") ||
        Object.hasOwn(input, "guardian") && (!input.guardian || typeof input.guardian.approvalPath !== "string" || !input.guardian.approvalPath ||
          typeof input.guardian.identities?.read !== "function" || typeof input.guardian.authorities?.read !== "function")) throw new TypeError("invalid representative identity sources");
    const guardian = input.guardian;
    if (guardian) {
      const identities = guardian.identities, readIdentity = identities.read, authorities = guardian.authorities, readAuthority = authorities.read;
      this.#input = Object.freeze({ ...input, guardian: Object.freeze({ ...guardian,
        identities: Object.freeze({ read: inheritClinikoRequestCost((query: Parameters<typeof readIdentity>[0]) => readIdentity.call(identities, query), readIdentity) }),
        authorities: Object.freeze({ read: inheritClinikoRequestCost((query: Parameters<typeof readAuthority>[0]) => readAuthority.call(authorities, query), readAuthority) }),
      }) });
    } else this.#input = Object.freeze({ ...input });
    this.#context = context; this.#operation = operation; this.#current = current;
    context.signal.addEventListener("abort", this.#onClose, { once: true });
    if (context.signal.aborted) this.dispose();
  }
  #live(signal: AbortSignal) { return !this.#closed && !signal.aborted && !this.#context.signal.aborted && this.#current(); }
  async prepare(signal: AbortSignal): Promise<boolean> {
    if (this.#attempted || !this.#live(signal)) return false;
    this.#attempted = true;
    const c = this.#context, input = this.#input, scope = c.receipt.scope, clock = c.clock ?? (() => new Date().toISOString()), fingerprint = clinikoCredentialFingerprint(c.cliniko.apiKey);
    try {
      if (Object.hasOwn(input, "callerApprovalPath")) {
        const native = input as NativeInput;
        const [caller, process] = await Promise.all([
          OwnerFileCallerPolicy.capture({ path: native.callerApprovalPath, scope, policyVersion: c.policyVersion, operation: "appointments.read", directory: c.directory, clock }),
          OwnerFileRepresentativePolicy.capture({ path: native.representativeApprovalPath, scope, policyVersion: c.policyVersion,
            businessId: c.cliniko.businessId, credentialFingerprint: fingerprint, timeZone: c.cliniko.timeZone, directory: c.directory, clock }),
        ]);
        if (!caller.ok || !process.ok || !this.#live(signal)) return false;
        const policy = { operation: "appointments.read" as const, current: async (bound: typeof scope) => {
          const method = await caller.value.current(bound), current = await process.value.current(bound);
          return method.ok ? ok({ ...method.value, enabled: method.value.enabled && current.ok &&
            current.value.operations.includes(this.#operation) && !this.#closed && this.#current() }) : method;
        } };
        this.#approvals.push(async () => { const current = await policy.current(scope); return current.ok && current.value.enabled; });
        const made = CallerVerificationSession.create({ ...c, operation: "appointments.read", policyStore: c.policies, policy,
          contact: new ClinikoVerificationContactReader({ ...c.cliniko, scope }, c.fetchPort), permission: native.callerPermission, budget: c.verificationBudget });
        if (!made.ok) return false;
        this.#allocated.add(made.value); if (!this.#live(signal)) return false;
        const selection = new ClinikoRepresentativeSelection({ ...c, actor: made.value, actorOperation: "appointments.read", policy: process.value,
          representativeCallerApprovalPath: input.representativeCallerApprovalPath, permission: native.permission });
        this.#allocated.add(selection); this.#sources.set("clinicPatient", { actor: made.value, selection });
      }
      if (input.guardian) {
        const provision = input.guardian, captured = await OwnerFileGuardianPolicy.capture({ path: provision.approvalPath, scope, policyVersion: c.policyVersion,
          businessId: c.cliniko.businessId, credentialFingerprint: fingerprint, timeZone: c.cliniko.timeZone, directory: c.directory, clock });
        if (!captured.ok || !this.#live(signal)) return false;
        const approval = await captured.value.current(scope);
        if (!approval.ok || !approval.value.operations.includes(this.#operation) || !this.#live(signal)) return false;
        this.#approvals.push(async () => { const current = await captured.value.current(scope); return current.ok && current.value.operations.includes(this.#operation); });
        const account = { businessId: c.cliniko.businessId, credentialFingerprint: fingerprint, budget: c.cliniko.rateBudget };
        const contact = new ClinikoGuardianContactReader({ ...c.cliniko, scope, policyVersion: c.policyVersion, records: provision.identities, directory: c.directory, clock }, c.fetchPort);
        const made = GuardianVerificationSession.create({ ...c, operation: this.#operation, policyStore: c.policies, policy: captured.value,
          account, contact, budget: c.verificationBudget });
        if (!made.ok) return false;
        this.#allocated.add(made.value); if (!this.#live(signal)) return false;
        const authority = new GuardianPatientAuthority({ scope, callId: c.receipt.callId, sessionId: c.sessionId, policyVersion: c.policyVersion,
          ...account, actor: made.value, policy: captured.value, records: provision.authorities, directory: c.directory, clock, signal: c.signal });
        this.#allocated.add(authority);
        const selection = new ClinikoGuardianSelection({ ...c, actor: made.value, policy: captured.value, authority,
          representativeCallerApprovalPath: input.representativeCallerApprovalPath });
        this.#allocated.add(selection); this.#sources.set("guardianRecord", { actor: made.value, selection });
      }
      for (const current of this.#approvals) if (!await current() || !this.#live(signal)) return false;
      this.#prepared = this.#sources.size > 0 && this.#live(signal); return this.#prepared;
    } finally { if (!this.#prepared) this.dispose(); }
  }
  methods(): readonly RepresentativeCallerMethod[] { return this.#prepared && !this.#closed ? [...this.#sources.keys()] : []; }
  source(method: RepresentativeCallerMethod): Source | undefined { return this.#prepared && !this.#closed ? this.#sources.get(method) : undefined; }
  retain(method: RepresentativeCallerMethod): boolean {
    if (!this.source(method)) return false;
    for (const [key, source] of this.#sources) if (key !== method) { source.selection.dispose(); source.actor.dispose(); this.#sources.delete(key); }
    return true;
  }
  dispose(): void {
    this.#closed = true; this.#context.signal.removeEventListener("abort", this.#onClose);
    for (const resource of this.#allocated) resource.dispose(); this.#allocated.clear(); this.#sources.clear();
  }
}
