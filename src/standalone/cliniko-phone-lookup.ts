import { setTimeout as wait } from "node:timers/promises";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { normalizePatientPhone } from "../cliniko/phone-number.ts";
import type { ClinikoClinicScope, ClinikoPatientFailure } from "../cliniko/patients.ts";
import { ClinikoPatientCandidateReader } from "../cliniko/patients.ts";
import type { PhoneIndexFailure } from "../storage/postgres-patient-phone-index.ts";
import { PostgresPatientPhoneIndex } from "../storage/postgres-patient-phone-index.ts";
import type { PhoneScanFailure, PhoneScanCursor } from "../storage/postgres-patient-phone-scan.ts";
import { PostgresPatientPhoneScan } from "../storage/postgres-patient-phone-scan.ts";
import type { CallerCandidates } from "../voice/caller-candidates.ts";
import type { CallerCandidateLookup } from "../voice/caller-candidates.ts";
import { declareClinikoRequestCost } from "../cliniko/request-cost.ts";
import type { ClinikoCostBinding } from "../cliniko/request-cost.ts";

export type PhoneLookupResult = CallerCandidates;

/** Standalone composition: phone gives candidates, never identity proof. */
export class ClinikoPhoneLookup {
  private readonly reader: ClinikoPatientCandidateReader;
  private readonly index: PostgresPatientPhoneIndex;
  private readonly countryCallingCode: string;
  private readonly maxIndexAgeMs: number;
  private readonly waitUntil: (resetAt: string) => Promise<void>;
  private readonly scan: PostgresPatientPhoneScan | undefined;

  constructor(reader: ClinikoPatientCandidateReader, index: PostgresPatientPhoneIndex,
              countryCallingCode: string, maxIndexAgeMs: number,
              waitUntil: (resetAt: string) => Promise<void> = async resetAt => {
                const delay = Date.parse(resetAt) - Date.now();
                if (!Number.isFinite(delay) || delay > 120_000) throw new Error("rate reset outside scan budget");
                if (delay > 0) await wait(delay);
              }, scan?: PostgresPatientPhoneScan) {
    this.reader = reader;
    this.index = index;
    this.countryCallingCode = countryCallingCode;
    this.maxIndexAgeMs = maxIndexAgeMs;
    this.waitUntil = waitUntil;
    this.scan = scan;
  }

  credentialFingerprint(): string { return this.reader.credentialFingerprint(); }

  async refresh(scope: ClinikoClinicScope): Promise<Result<number, ClinikoPatientFailure | PhoneIndexFailure | PhoneScanFailure>> {
    if (this.scan) return this.refreshStaged(scope, this.scan);
    const head = await this.index.head(scope);
    if (!head.ok) return head;
    const revision = await this.index.contactRevision(scope, this.credentialFingerprint());
    if (!revision.ok) return revision;
    if (revision.value.blocked) return err({ kind: "contactChanged" });
    const generation = head.value?.generation ?? null;
    const snapshot = await this.reader.readPhoneSnapshot(scope, this.countryCallingCode, 100_000, this.waitUntil);
    if (!snapshot.ok) {
      const stale = await this.index.markStale(scope, generation);
      return stale.ok ? snapshot : stale;
    }
    const published = await this.index.publish(scope, snapshot.value.links, this.countryCallingCode,
      this.credentialFingerprint(), generation, revision.value.version);
    if (published.ok || published.error.kind === "generationChanged") return published;
    const stale = await this.index.markStale(scope, generation);
    return stale.ok ? published : stale;
  }

  private async refreshStaged(scope: ClinikoClinicScope, scan: PostgresPatientPhoneScan):
    Promise<Result<number, ClinikoPatientFailure | PhoneIndexFailure | PhoneScanFailure>> {
    const started = await scan.begin(scope, this.countryCallingCode, this.credentialFingerprint());
    if (!started.ok) return started;
    let cursor: PhoneScanCursor = started.value;
    if (cursor.totalEntries === null || cursor.seenCount < cursor.totalEntries) {
      for await (const page of this.reader.phonePages(scope, this.countryCallingCode, cursor.nextPage, 100_000, this.waitUntil)) {
        if (!page.ok) {
          if (page.error.kind === "malformed" || page.error.kind === "tooManyResults" ||
              page.error.kind === "invalidQuery" || page.error.kind === "scopeMismatch") {
            const discarded = await scan.discard(scope, cursor.scanRef);
            if (!discarded.ok) return discarded;
          }
          const stale = await this.index.markStale(scope, cursor.expectedGeneration);
          return stale.ok ? page : stale;
        }
        const staged = await scan.append(scope, cursor.scanRef, page.value);
        if (!staged.ok) {
          if (staged.error.kind === "sourceChanged" || staged.error.kind === "tooManyResults" ||
              staged.error.kind === "invalidInput") {
            const discarded = await scan.discard(scope, cursor.scanRef);
            if (!discarded.ok) return discarded;
          }
          if (staged.error.kind === "staleScan") return staged;
          const stale = await this.index.markStale(scope, cursor.expectedGeneration);
          return stale.ok ? staged : stale;
        }
        cursor = staged.value;
      }
    }
    // Offset pages are not a point-in-time Cliniko snapshot. Re-read multi-page
    // scans and compare every ID and phone link before exposing a new generation.
    if (cursor.totalEntries !== null && cursor.totalEntries > 100) {
      const seenIds = new Set<string>();
      for await (const page of this.reader.phonePages(scope, this.countryCallingCode, 1, 100_000, this.waitUntil)) {
        if (!page.ok) {
          if (["malformed", "tooManyResults", "invalidQuery", "scopeMismatch"].includes(page.error.kind)) {
            const discarded = await scan.discard(scope, cursor.scanRef);
            if (!discarded.ok) return discarded;
          }
          const stale = await this.index.markStale(scope, cursor.expectedGeneration);
          return stale.ok ? page : stale;
        }
        if (page.value.patientIds.some(id => seenIds.has(id))) {
          const discarded = await scan.discard(scope, cursor.scanRef);
          if (!discarded.ok) return discarded;
          const stale = await this.index.markStale(scope, cursor.expectedGeneration);
          return stale.ok ? err({ kind: "sourceChanged" }) : stale;
        }
        for (const id of page.value.patientIds) seenIds.add(id);
        const verified = await scan.verifyPage(scope, cursor.scanRef, page.value);
        if (!verified.ok) {
          if (verified.error.kind === "sourceChanged" || verified.error.kind === "invalidInput") {
            const discarded = await scan.discard(scope, cursor.scanRef);
            if (!discarded.ok) return discarded;
          }
          const stale = await this.index.markStale(scope, cursor.expectedGeneration);
          return stale.ok ? verified : stale;
        }
      }
      if (seenIds.size !== cursor.totalEntries) {
        const discarded = await scan.discard(scope, cursor.scanRef);
        if (!discarded.ok) return discarded;
        const stale = await this.index.markStale(scope, cursor.expectedGeneration);
        return stale.ok ? err({ kind: "sourceChanged" }) : stale;
      }
    }
    const finished = await scan.finish(scope, cursor.scanRef);
    if (finished.ok || finished.error.kind === "staleScan") return finished;
    if (finished.error.kind === "sourceChanged") {
      const discarded = await scan.discard(scope, cursor.scanRef);
      if (!discarded.ok) return discarded;
    }
    const stale = await this.index.markStale(scope, cursor.expectedGeneration);
    return stale.ok ? finished : stale;
  }

  /** Quote an enforced ceiling for this admitted number without filtering any
   * candidate or granting identity. Growth beyond the captured count refuses
   * before native reads; a later workflow must obtain its own current quote. */
  async forVerificationBudget(binding: ClinikoCostBinding, presentedCallerNumber: string, signal: AbortSignal): Promise<CallerCandidateLookup | undefined> {
    const scope = Object.freeze({ tenantId: binding.scope.tenantId, clinicId: binding.scope.clinicId });
    const captured = Object.freeze({ ...binding, scope });
    const current = () => Object.getPrototypeOf(this) === ClinikoPhoneLookup.prototype && this.candidates === nativeCandidates &&
      Object.getPrototypeOf(this.index) === PostgresPatientPhoneIndex.prototype && this.index.find === indexedCandidates &&
      ClinikoPatientCandidateReader.prototype.nativePhoneRequestCostCeiling.call(this.reader, captured) === 1;
    if (signal.aborted || !current()) return undefined;
    const phone = normalizePatientPhone(presentedCallerNumber, this.countryCallingCode);
    const indexed = phone ? await this.index.find(scope, phone, this.maxIndexAgeMs, this.countryCallingCode, this.credentialFingerprint()) : undefined;
    if (signal.aborted || !current() || indexed && (!indexed.ok || indexed.value.kind === "stale" || indexed.value.kind === "tooMany")) return undefined;
    const maximum = indexed?.ok ? indexed.value.patientIds.length : 0;
    if (maximum > 10) return undefined;
    return Object.freeze({ candidates: declareClinikoRequestCost(async (bound: ClinikoClinicScope, number: string, stop?: AbortSignal) => {
      if (signal.aborted || stop?.aborted || !current() || bound.tenantId !== scope.tenantId || bound.clinicId !== scope.clinicId || number !== presentedCallerNumber)
        return err({ kind: "unavailable" as const });
      return this.#candidates(bound, number, maximum, AbortSignal.any([signal, ...(stop ? [stop] : [])]), current);
    }, captured, maximum) });
  }

  async candidates(scope: ClinikoClinicScope, presentedCallerNumber: string, signal?: AbortSignal):
    Promise<Result<PhoneLookupResult, ClinikoPatientFailure | PhoneIndexFailure>> {
    return this.#candidates(scope, presentedCallerNumber, 10, signal);
  }
  async #candidates(scope: ClinikoClinicScope, presentedCallerNumber: string, maximum: number, signal?: AbortSignal, current: () => boolean = () => true):
    Promise<Result<PhoneLookupResult, ClinikoPatientFailure | PhoneIndexFailure>> {
    if (signal?.aborted || !current()) return err({ kind: "unavailable" });
    const phone = normalizePatientPhone(presentedCallerNumber, this.countryCallingCode);
    if (!phone) return ok({ kind: "noNumber", candidateIds: [] });
    const indexed = await this.index.find(scope, phone, this.maxIndexAgeMs, this.countryCallingCode,
      this.credentialFingerprint());
    if (!indexed.ok) return indexed;
    if (indexed.value.kind === "stale") return ok({ kind: "indexStale", candidateIds: [] });
    if (indexed.value.kind === "tooMany") return ok({ kind: "tooMany", candidateIds: [] });
    if (indexed.value.patientIds.length > maximum) return err({ kind: "unavailable" });
    const candidateIds: string[] = [];
    for (const patientId of indexed.value.patientIds) {
      if (signal?.aborted || !current()) return err({ kind: "unavailable" });
      const found = await this.reader.hasCurrentPhone(scope, patientId, phone, this.countryCallingCode, signal);
      if (!found.ok) return err(found.error);
      if (found.value) candidateIds.push(patientId);
    }
    if (indexed.value.patientIds.length) {
      // Provider reads may outlive a clinic disconnect, failed scan, or replacement generation.
      const latest = await this.index.find(scope, phone, this.maxIndexAgeMs, this.countryCallingCode,
        this.credentialFingerprint());
      if (!latest.ok) return latest;
      if (latest.value.kind === "stale" || latest.value.kind === "tooMany" ||
          latest.value.generation !== indexed.value.generation ||
          latest.value.patientIds.length !== indexed.value.patientIds.length ||
          latest.value.patientIds.some((id, index) => id !== indexed.value.patientIds[index])) {
        return ok({ kind: "indexStale", candidateIds: [] });
      }
    }
    if (signal?.aborted || !current()) return err({ kind: "unavailable" });
    const kind = candidateIds.length === 0 ? "none" : candidateIds.length === 1 ? "one" : "multiple";
    return ok({ kind, candidateIds });
  }
}
const nativeCandidates = ClinikoPhoneLookup.prototype.candidates;
const indexedCandidates = PostgresPatientPhoneIndex.prototype.find;
