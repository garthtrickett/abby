import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { normalizePatientPhone } from "./phone-number.ts";
import { normalizeEmailAddress } from "../shared/email-address.ts";
import { claimClinikoBudget, ClinikoReadBudget, clinikoCredentialFingerprint, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { boundedClinikoJson } from "./bounded-json.ts";
import type { ClinikoPatientConfig } from "./patients.ts";

export type VerificationContactFailure = Readonly<{ kind: "denied" | "unavailable" }>;
export interface VerificationContact {
  /** Transient registered address only. Neither appointment facts nor a caller-supplied destination. */
  read(scope: LocationScope, patientId: string, normalizedPhone: string, signal: AbortSignal):
    Promise<Result<string, VerificationContactFailure>>;
}

function row(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A fresh patient-by-ID read is allowed before proof, but no protected appointment read is. */
export class ClinikoVerificationContactReader implements VerificationContact {
  readonly #config: ClinikoPatientConfig;
  readonly #base: string;
  readonly #budget: ClinikoRequestBudget;
  readonly #country: string;
  readonly #fetch: typeof fetch;
  constructor(config: ClinikoPatientConfig & Readonly<{ countryCallingCode: string }>, fetchPort: typeof fetch = fetch) {
    const shard = typeof config?.apiKey === "string" ? config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1] : undefined;
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || /[\u0000-\u001f\u007f]/.test(config.apiKey) ||
        !config.scope || ![config.scope.tenantId, config.scope.clinicId].every(value =>
          typeof value === "string" && !!value.trim() && value.length <= 256) ||
        !normalizeEmailAddress(config.contactEmail) || !/^[1-9][0-9]{0,2}$/.test(config.countryCallingCode) ||
        typeof fetchPort !== "function") throw new TypeError("invalid verification contact configuration");
    this.#config = { ...config, scope: { ...config.scope } };
    this.#base = `https://api.${shard}.cliniko.com/v1`;
    this.#budget = config.rateBudget ?? new ClinikoReadBudget();
    this.#country = config.countryCallingCode;
    this.#fetch = fetchPort;
  }

  /** Private composition identity; no key or patient/contact value leaves this reader. */
  selection(): Readonly<{ scope: Pick<LocationScope, "tenantId" | "clinicId">; credentialFingerprint: string }> {
    return { scope: { tenantId: this.#config.scope.tenantId, clinicId: this.#config.scope.clinicId }, credentialFingerprint: clinikoCredentialFingerprint(this.#config.apiKey) };
  }

  async read(scope: LocationScope, patientId: string, normalizedPhone: string, signal: AbortSignal):
    Promise<Result<string, VerificationContactFailure>> {
    if (!scope || scope.tenantId !== this.#config.scope.tenantId || scope.clinicId !== this.#config.scope.clinicId ||
        !/^[1-9][0-9]{0,18}$/.test(patientId) || !/^\+[1-9][0-9]{7,14}$/.test(normalizedPhone) || signal.aborted) {
      return err({ kind: "denied" });
    }
    const denied = await claimClinikoBudget(this.#budget);
    if (denied || signal.aborted) return err({ kind: "unavailable" });
    try {
      const response = await this.#fetch(`${this.#base}/patients/${patientId}`, {
        method: "GET", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`,
          "User-Agent": `Abby (${this.#config.contactEmail})` },
      });
      if (response.status === 429) await observeCliniko429(this.#budget, response.headers.get("X-RateLimit-Reset"));
      if (response.status !== 200) return err({ kind: "unavailable" });
      const parsed = await boundedClinikoJson(response);
      if (!parsed.ok || signal.aborted) return err({ kind: "unavailable" });
      const patient = row(parsed.value);
      if (!patient || patient.id !== patientId || patient.archived_at !== null ||
          !Array.isArray(patient.patient_phone_numbers) || patient.patient_phone_numbers.length > 20) return err({ kind: "denied" });
      const email = normalizeEmailAddress(patient.email);
      if (!email) return err({ kind: "denied" });
      let matches = false;
      for (const item of patient.patient_phone_numbers) {
        const phone = row(item);
        if (!phone || (phone.number !== null && typeof phone.number !== "string") ||
            (phone.phone_type !== null && phone.phone_type !== undefined && typeof phone.phone_type !== "string")) {
          return err({ kind: "denied" });
        }
        if (String(phone.phone_type).toLowerCase() !== "fax" && typeof phone.number === "string" &&
            normalizePatientPhone(phone.number, this.#country) === normalizedPhone) matches = true;
      }
      return matches ? ok(email) : err({ kind: "denied" });
    } catch { return err({ kind: "unavailable" }); }
  }
}
