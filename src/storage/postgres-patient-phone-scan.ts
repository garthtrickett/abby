import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { PHONE_NORMALIZATION_VERSION } from "../cliniko/phone-number.ts";
import type Database from "./generated/Database.ts";
import type { PatientPhoneScanClinicId, PatientPhoneScanTenantId } from "./generated/public/PatientPhoneScan.ts";
import type { PatientPhoneScanLinksNormalizedPhone, PatientPhoneScanLinksPatientId,
  PatientPhoneScanLinksScanRef } from "./generated/public/PatientPhoneScanLinks.ts";
import type { PatientPhoneScanSeenPatientId, PatientPhoneScanSeenScanRef } from "./generated/public/PatientPhoneScanSeen.ts";
import type { PatientPhoneIndexClinicId, PatientPhoneIndexTenantId } from "./generated/public/PatientPhoneIndex.ts";
import type { PatientPhoneSyncClinicId, PatientPhoneSyncTenantId } from "./generated/public/PatientPhoneSync.ts";
import type { PatientPhoneClinicStatusClinicId, PatientPhoneClinicStatusTenantId } from "./generated/public/PatientPhoneClinicStatus.ts";
import type { PatientPhoneClinicScope, PatientPhoneLink } from "./postgres-patient-phone-index.ts";

export type PhoneScanFailure = Readonly<{ kind: "invalidInput" | "storageFailure" | "staleScan" | "sourceChanged" | "tooManyResults" | "clinicDisconnected" }>;
export type PhoneScanCursor = Readonly<{
  scanRef: string;
  countryCallingCode: string;
  nextPage: number;
  totalEntries: number | null;
  seenCount: number;
  linkCount: number;
  expectedGeneration: number | null;
}>;
export type PhoneScanPage = Readonly<{
  page: number;
  totalEntries: number;
  patientIds: readonly string[];
  links: readonly PatientPhoneLink[];
}>;

const phonePattern = /^\+[1-9][0-9]{7,14}$/;
const patientIdPattern = /^[1-9][0-9]{0,19}$/;
const scanRefPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validScope(scope: PatientPhoneClinicScope): boolean {
  return !!scope && [scope.tenantId, scope.clinicId].every(part =>
    typeof part === "string" && !!part && part.length <= 256);
}

function compareIds(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}

function cursor(row: { scan_ref: string; country_calling_code: string; next_page: number; total_entries: number | null;
  seen_count: number; link_count: number; expected_generation: number | null }): PhoneScanCursor {
  return { scanRef: row.scan_ref, countryCallingCode: row.country_calling_code,
    nextPage: row.next_page, totalEntries: row.total_entries, seenCount: row.seen_count,
    linkCount: row.link_count, expectedGeneration: row.expected_generation };
}

/** Checkpoints only Cliniko patient IDs, phone numbers, and non-patient scan metadata. */
export class PostgresPatientPhoneScan {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) { this.db = db; }

  async begin(scope: PatientPhoneClinicScope, countryCallingCode: string): Promise<Result<PhoneScanCursor, PhoneScanFailure>> {
    if (!validScope(scope) || !/^[1-9][0-9]{0,2}$/.test(countryCallingCode)) return err({ kind: "invalidInput" });
    try {
      return await this.db.transaction().execute(async trx => {
        await sql`select pg_advisory_xact_lock(hashtext(${scope.tenantId}), hashtext(${scope.clinicId}))`.execute(trx);
        const connection = await trx.selectFrom("patient_phone_clinic_status").select("enabled")
          .where("tenant_id", "=", scope.tenantId as PatientPhoneClinicStatusTenantId)
          .where("clinic_id", "=", scope.clinicId as PatientPhoneClinicStatusClinicId).executeTakeFirst();
        if (connection?.enabled === false) return err({ kind: "clinicDisconnected" });
        const ids = { tenant_id: scope.tenantId as PatientPhoneScanTenantId,
          clinic_id: scope.clinicId as PatientPhoneScanClinicId };
        const head = await trx.selectFrom("patient_phone_sync").select("generation")
          .where("tenant_id", "=", scope.tenantId as PatientPhoneSyncTenantId)
          .where("clinic_id", "=", scope.clinicId as PatientPhoneSyncClinicId).executeTakeFirst();
        const existing = await trx.selectFrom("patient_phone_scan").selectAll()
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).executeTakeFirst();
        if (existing && existing.country_calling_code === countryCallingCode &&
            existing.normalization_version === PHONE_NORMALIZATION_VERSION &&
            existing.expected_generation === (head?.generation ?? null) &&
            existing.started_at instanceof Date && Date.now() - existing.started_at.getTime() < 86_400_000) {
          return ok(cursor(existing));
        }
        if (existing) await trx.deleteFrom("patient_phone_scan")
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).execute();
        const fresh: PhoneScanCursor = { scanRef: randomUUID(), countryCallingCode,
          nextPage: 1, totalEntries: null, seenCount: 0, linkCount: 0,
          expectedGeneration: head?.generation ?? null };
        await trx.insertInto("patient_phone_scan").values({ ...ids,
          scan_ref: fresh.scanRef, country_calling_code: countryCallingCode,
          expected_generation: fresh.expectedGeneration, next_page: 1, total_entries: null,
          seen_count: 0, link_count: 0, normalization_version: PHONE_NORMALIZATION_VERSION }).execute();
        return ok(fresh);
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async append(scope: PatientPhoneClinicScope, scanRef: string, page: PhoneScanPage):
    Promise<Result<PhoneScanCursor, PhoneScanFailure>> {
    if (!validScope(scope) || !scanRefPattern.test(scanRef) || !page ||
        !Number.isSafeInteger(page.page) || page.page < 1 || !Number.isSafeInteger(page.totalEntries) ||
        page.totalEntries < 0 || page.totalEntries > 100_000 || !Array.isArray(page.patientIds) ||
        page.patientIds.length > 100 || page.patientIds.some(id => !patientIdPattern.test(id)) ||
        !Array.isArray(page.links) || page.links.some(link => !link || !phonePattern.test(link.normalizedPhone) ||
          !patientIdPattern.test(link.patientId))) return err({ kind: "invalidInput" });
    const expectedCount = Math.min(100, Math.max(0, page.totalEntries - (page.page - 1) * 100));
    if (page.patientIds.length !== expectedCount ||
        page.patientIds.some((id, index) => index > 0 && compareIds(page.patientIds[index - 1]!, id) >= 0)) {
      return err({ kind: "sourceChanged" });
    }
    const pageIds = new Set(page.patientIds);
    const links = [...new Map(page.links.map(link => [`${link.normalizedPhone}\0${link.patientId}`, link])).values()];
    if (links.some(link => !pageIds.has(link.patientId))) return err({ kind: "invalidInput" });
    try {
      return await this.db.transaction().execute(async trx => {
        await sql`select pg_advisory_xact_lock(hashtext(${scope.tenantId}), hashtext(${scope.clinicId}))`.execute(trx);
        const ids = { tenant_id: scope.tenantId as PatientPhoneScanTenantId,
          clinic_id: scope.clinicId as PatientPhoneScanClinicId };
        const row = await trx.selectFrom("patient_phone_scan").selectAll()
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).forUpdate().executeTakeFirst();
        if (!row || row.scan_ref !== scanRef || row.next_page !== page.page) return err({ kind: "staleScan" });
        if (row.total_entries !== null && row.total_entries !== page.totalEntries) return err({ kind: "sourceChanged" });
        if (row.seen_count + page.patientIds.length > page.totalEntries || row.link_count + links.length > 100_000) {
          return err({ kind: "tooManyResults" });
        }
        if (pageIds.size) {
          const previous = await sql<{ patient_id: string }>`select patient_id from patient_phone_scan_seen
            where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} and scan_ref = ${scanRef}::uuid
            order by length(patient_id) desc, patient_id desc limit 1`.execute(trx);
          if (previous.rows[0] && compareIds(previous.rows[0].patient_id, page.patientIds[0]!) >= 0) {
            return err({ kind: "sourceChanged" });
          }
          await trx.insertInto("patient_phone_scan_seen").values(page.patientIds.map(patientId => ({
            tenant_id: scope.tenantId as PatientPhoneScanTenantId,
            clinic_id: scope.clinicId as PatientPhoneScanClinicId,
            scan_ref: scanRef as PatientPhoneScanSeenScanRef,
            patient_id: patientId as PatientPhoneScanSeenPatientId,
          }))).execute();
        }
        for (let offset = 0; offset < links.length; offset += 500) {
          await trx.insertInto("patient_phone_scan_links").values(links.slice(offset, offset + 500).map(link => ({
            tenant_id: scope.tenantId as PatientPhoneScanTenantId,
            clinic_id: scope.clinicId as PatientPhoneScanClinicId,
            scan_ref: scanRef as PatientPhoneScanLinksScanRef,
            normalized_phone: link.normalizedPhone as PatientPhoneScanLinksNormalizedPhone,
            patient_id: link.patientId as PatientPhoneScanLinksPatientId,
          }))).execute();
        }
        const next = { next_page: page.page + 1, total_entries: page.totalEntries,
          seen_count: row.seen_count + page.patientIds.length, link_count: row.link_count + links.length,
          updated_at: new Date() };
        await trx.updateTable("patient_phone_scan").set(next)
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).execute();
        return ok(cursor({ ...row, ...next }));
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async finish(scope: PatientPhoneClinicScope, scanRef: string): Promise<Result<number, PhoneScanFailure>> {
    if (!validScope(scope) || !scanRefPattern.test(scanRef)) return err({ kind: "invalidInput" });
    try {
      return await this.db.transaction().execute(async trx => {
        await sql`select pg_advisory_xact_lock(hashtext(${scope.tenantId}), hashtext(${scope.clinicId}))`.execute(trx);
        const row = await trx.selectFrom("patient_phone_scan").selectAll()
          .where("tenant_id", "=", scope.tenantId as PatientPhoneScanTenantId)
          .where("clinic_id", "=", scope.clinicId as PatientPhoneScanClinicId).forUpdate().executeTakeFirst();
        if (!row || row.scan_ref !== scanRef) return err({ kind: "staleScan" });
        if (row.normalization_version !== PHONE_NORMALIZATION_VERSION ||
            row.total_entries === null || row.seen_count !== row.total_entries ||
            row.next_page !== Math.max(1, Math.ceil(row.total_entries / 100)) + 1) return err({ kind: "sourceChanged" });
        const head = await trx.selectFrom("patient_phone_sync").select("generation")
          .where("tenant_id", "=", scope.tenantId as PatientPhoneSyncTenantId)
          .where("clinic_id", "=", scope.clinicId as PatientPhoneSyncClinicId).executeTakeFirst();
        if ((head?.generation ?? null) !== row.expected_generation) return err({ kind: "staleScan" });
        const generation = (head?.generation ?? 0) + 1;
        await trx.deleteFrom("patient_phone_index")
          .where("tenant_id", "=", scope.tenantId as PatientPhoneIndexTenantId)
          .where("clinic_id", "=", scope.clinicId as PatientPhoneIndexClinicId).execute();
        await sql`insert into patient_phone_index (tenant_id, clinic_id, normalized_phone, patient_id)
          select tenant_id, clinic_id, normalized_phone, patient_id from patient_phone_scan_links
          where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} and scan_ref = ${scanRef}::uuid`.execute(trx);
        await trx.insertInto("patient_phone_sync").values({ tenant_id: scope.tenantId as PatientPhoneSyncTenantId,
          clinic_id: scope.clinicId as PatientPhoneSyncClinicId, generation, completed_at: new Date(),
          country_calling_code: row.country_calling_code,
          normalization_version: row.normalization_version })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id"])
            .doUpdateSet({ generation, completed_at: new Date(), country_calling_code: row.country_calling_code,
              normalization_version: row.normalization_version })).execute();
        await trx.deleteFrom("patient_phone_scan")
          .where("tenant_id", "=", scope.tenantId as PatientPhoneScanTenantId)
          .where("clinic_id", "=", scope.clinicId as PatientPhoneScanClinicId).execute();
        return ok(generation);
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async discard(scope: PatientPhoneClinicScope, scanRef: string): Promise<Result<true, PhoneScanFailure>> {
    if (!validScope(scope) || !scanRefPattern.test(scanRef)) return err({ kind: "invalidInput" });
    try {
      await this.db.deleteFrom("patient_phone_scan")
        .where("tenant_id", "=", scope.tenantId as PatientPhoneScanTenantId)
        .where("clinic_id", "=", scope.clinicId as PatientPhoneScanClinicId)
        .where("scan_ref", "=", scanRef).execute();
      return ok(true);
    } catch { return err({ kind: "storageFailure" }); }
  }
}
