import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { normalizePatientPhone } from "../cliniko/phone-number.ts";
import type { ClinikoClinicScope, ClinikoPatientFailure } from "../cliniko/patients.ts";
import { ClinikoPatientCandidateReader } from "../cliniko/patients.ts";
import type { PhoneIndexFailure } from "../storage/postgres-patient-phone-index.ts";
import { PostgresPatientPhoneIndex } from "../storage/postgres-patient-phone-index.ts";
import type { CallerCandidates } from "../voice/caller-candidates.ts";

export type PhoneLookupResult = CallerCandidates;

/** Standalone composition: phone gives candidates, never identity proof. */
export class ClinikoPhoneLookup {
  private readonly reader: ClinikoPatientCandidateReader;
  private readonly index: PostgresPatientPhoneIndex;
  private readonly countryCallingCode: string;
  private readonly maxIndexAgeMs: number;

  constructor(reader: ClinikoPatientCandidateReader, index: PostgresPatientPhoneIndex,
              countryCallingCode: string, maxIndexAgeMs: number) {
    this.reader = reader;
    this.index = index;
    this.countryCallingCode = countryCallingCode;
    this.maxIndexAgeMs = maxIndexAgeMs;
  }

  async refresh(scope: ClinikoClinicScope): Promise<Result<number, ClinikoPatientFailure | PhoneIndexFailure>> {
    const snapshot = await this.reader.readPhoneSnapshot(scope, this.countryCallingCode);
    if (!snapshot.ok) return snapshot;
    return this.index.publish(scope, snapshot.value.links);
  }

  async candidates(scope: ClinikoClinicScope, presentedCallerNumber: string):
    Promise<Result<PhoneLookupResult, ClinikoPatientFailure | PhoneIndexFailure>> {
    const phone = normalizePatientPhone(presentedCallerNumber, this.countryCallingCode);
    if (!phone) return ok({ kind: "noNumber", candidateIds: [] });
    const indexed = await this.index.find(scope, phone, this.maxIndexAgeMs);
    if (!indexed.ok) return indexed;
    if (indexed.value.kind === "stale") return ok({ kind: "indexStale", candidateIds: [] });
    if (indexed.value.kind === "tooMany") return ok({ kind: "tooMany", candidateIds: [] });
    const candidateIds: string[] = [];
    for (const patientId of indexed.value.patientIds) {
      const current = await this.reader.hasCurrentPhone(scope, patientId, phone, this.countryCallingCode);
      if (!current.ok) return err(current.error);
      if (current.value) candidateIds.push(patientId);
    }
    const kind = candidateIds.length === 0 ? "none" : candidateIds.length === 1 ? "one" : "multiple";
    return ok({ kind, candidateIds });
  }
}
