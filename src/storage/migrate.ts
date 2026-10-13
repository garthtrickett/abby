import { Migrator } from "kysely";
import type { Kysely } from "kysely";
import { up as up001, down as down001 } from "./migrations/001_text_probe.ts";
import { up as up002, down as down002 } from "./migrations/002_booking_setting_audit.ts";
import { up as up003, down as down003 } from "./migrations/003_tenant_scope_constraints.ts";
import { up as up004, down as down004 } from "./migrations/004_automation_setting_audit.ts";
import { up as up005, down as down005 } from "./migrations/005_clinic_write_stop.ts";
import { up as up006, down as down006 } from "./migrations/006_write_stop_recovery.ts";
import { up as up007, down as down007 } from "./migrations/007_clinic_knowledge.ts";
import { up as up008, down as down008 } from "./migrations/008_pending_location_calls.ts";
import { up as up009, down as down009 } from "./migrations/009_effect_call_leases.ts";
import { up as up010, down as down010 } from "./migrations/010_effect_call_lease_versions.ts";
import { up as up011, down as down011 } from "./migrations/011_portability_fence.ts";
import { up as up012, down as down012 } from "./migrations/012_config_import_registry.ts";
import { up as up013, down as down013 } from "./migrations/013_number_cutover.ts";
import { up as up014, down as down014 } from "./migrations/014_patient_phone_index.ts";
import { up as up015, down as down015 } from "./migrations/015_remove_turn_digests.ts";
import { up as up016, down as down016 } from "./migrations/016_patient_phone_scan.ts";
import { up as up017, down as down017 } from "./migrations/017_phone_normalization_plan.ts";
import { up as up018, down as down018 } from "./migrations/018_phone_index_connection.ts";
import { up as up019, down as down019 } from "./migrations/019_phone_scan_verification_index.ts";
import { up as up020, down as down020 } from "./migrations/020_cliniko_request_budget.ts";
import { up as up021, down as down021 } from "./migrations/021_cutover_phone_index_readiness.ts";
import { up as up022, down as down022 } from "./migrations/022_cliniko_catalogue_approvals.ts";
import { up as up023, down as down023 } from "./migrations/023_phone_index_credentials.ts";
import { up as up024, down as down024 } from "./migrations/024_cliniko_approval_alternatives.ts";
import { up as up025, down as down025 } from "./migrations/025_clinic_operational_counts.ts";
import { up as up026, down as down026 } from "./migrations/026_cliniko_budget_operational_counts.ts";
import { up as up027, down as down027 } from "./migrations/027_cliniko_provider_unavailable_count.ts";
import { up as up028, down as down028 } from "./migrations/028_cliniko_approved_business_time_zone.ts";
import { up as up029, down as down029 } from "./migrations/029_clinic_operational_daily_counts.ts";
import { up as up030, down as down030 } from "./migrations/030_after_hours_setting_audit.ts";
import { up as up031, down as down031 } from "./migrations/031_urgent_setting_audit.ts";
import { up as up032, down as down032 } from "./migrations/032_intent_classification_unavailable_count.ts";
import { up as up033, down as down033 } from "./migrations/033_staff_schedule_setting_audit.ts";
import { up as up034, down as down034 } from "./migrations/034_greeting_setting_audit.ts";
import { up as up035, down as down035 } from "./migrations/035_cancellation_setting_audit.ts";
import { up as up036, down as down036 } from "./migrations/036_rescheduling_setting_audit.ts";
import { up as up037, down as down037 } from "./migrations/037_clinic_intake_setting.ts";
import { up as up038, down as down038 } from "./migrations/038_staffed_destination_setting_audit.ts";
import { up as up039, down as down039 } from "./migrations/039_clinic_notification_settings.ts";
import { up as up040, down as down040 } from "./migrations/040_clinic_voice_settings.ts";
import { up as up041, down as down041 } from "./migrations/041_admin_magic_link_identity.ts";
import { up as up042, down as down042 } from "./migrations/042_patient_verification_budget.ts";
import { up as up043, down as down043 } from "./migrations/043_clinic_patient_correction_setting.ts";
import { up as up044, down as down044 } from "./migrations/044_cliniko_contact_revision.ts";
import { up as up045, down as down045 } from "./migrations/045_cliniko_contact_change_registry.ts";

function createMigrator<DB>(db: Kysely<DB>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => ({
      "001_text_probe": { up: up001, down: down001 },
      "002_booking_setting_audit": { up: up002, down: down002 },
      "003_tenant_scope_constraints": { up: up003, down: down003 },
      "004_automation_setting_audit": { up: up004, down: down004 },
      "005_clinic_write_stop": { up: up005, down: down005 },
      "006_write_stop_recovery": { up: up006, down: down006 },
      "007_clinic_knowledge": { up: up007, down: down007 },
      "008_pending_location_calls": { up: up008, down: down008 },
      "009_effect_call_leases": { up: up009, down: down009 },
      "010_effect_call_lease_versions": { up: up010, down: down010 },
      "011_portability_fence": { up: up011, down: down011 },
      "012_config_import_registry": { up: up012, down: down012 },
      "013_number_cutover": { up: up013, down: down013 },
      "014_patient_phone_index": { up: up014, down: down014 },
      "015_remove_turn_digests": { up: up015, down: down015 },
      "016_patient_phone_scan": { up: up016, down: down016 },
      "017_phone_normalization_plan": { up: up017, down: down017 },
      "018_phone_index_connection": { up: up018, down: down018 },
      "019_phone_scan_verification_index": { up: up019, down: down019 },
      "020_cliniko_request_budget": { up: up020, down: down020 },
      "021_cutover_phone_index_readiness": { up: up021, down: down021 },
      "022_cliniko_catalogue_approvals": { up: up022, down: down022 },
      "023_phone_index_credentials": { up: up023, down: down023 },
      "024_cliniko_approval_alternatives": { up: up024, down: down024 },
      "025_clinic_operational_counts": { up: up025, down: down025 },
      "026_cliniko_budget_operational_counts": { up: up026, down: down026 },
      "027_cliniko_provider_unavailable_count": { up: up027, down: down027 },
      "028_cliniko_approved_business_time_zone": { up: up028, down: down028 },
      "029_clinic_operational_daily_counts": { up: up029, down: down029 },
      "030_after_hours_setting_audit": { up: up030, down: down030 },
      "031_urgent_setting_audit": { up: up031, down: down031 },
      "032_intent_classification_unavailable_count": { up: up032, down: down032 },
      "033_staff_schedule_setting_audit": { up: up033, down: down033 },
      "034_greeting_setting_audit": { up: up034, down: down034 },
      "035_cancellation_setting_audit": { up: up035, down: down035 },
      "036_rescheduling_setting_audit": { up: up036, down: down036 },
      "037_clinic_intake_setting": { up: up037, down: down037 },
      "038_staffed_destination_setting_audit": { up: up038, down: down038 },
      "039_clinic_notification_settings": { up: up039, down: down039 },
      "040_clinic_voice_settings": { up: up040, down: down040 },
      "041_admin_magic_link_identity": { up: up041, down: down041 },
      "042_patient_verification_budget": { up: up042, down: down042 },
      "043_clinic_patient_correction_setting": { up: up043, down: down043 },
      "044_cliniko_contact_revision": { up: up044, down: down044 },
      "045_cliniko_contact_change_registry": { up: up045, down: down045 },
    }) },
  });
}

function assertMigration(outcome: Awaited<ReturnType<Migrator["migrateToLatest"]>>): void {
  if (outcome.error) throw outcome.error;
  if (outcome.results?.some(result => result.status !== "Success")) throw new Error("migration failed");
}

export async function migrate<DB>(db: Kysely<DB>, direction: "up" | "down" = "up"): Promise<void> {
  const migrator = createMigrator(db);
  assertMigration(direction === "up" ? await migrator.migrateToLatest() : await migrator.migrateDown());
}

/** Used by the upgrade probe to boot an actual older schema before seeding data. */
export async function migrateTo<DB>(db: Kysely<DB>, target: "001_text_probe" | "002_booking_setting_audit" | "003_tenant_scope_constraints" | "004_automation_setting_audit" | "005_clinic_write_stop" | "006_write_stop_recovery" | "007_clinic_knowledge" | "008_pending_location_calls" | "009_effect_call_leases" | "010_effect_call_lease_versions" | "011_portability_fence" | "012_config_import_registry" | "013_number_cutover" | "014_patient_phone_index" | "015_remove_turn_digests" | "016_patient_phone_scan" | "017_phone_normalization_plan" | "018_phone_index_connection" | "019_phone_scan_verification_index" | "020_cliniko_request_budget" | "021_cutover_phone_index_readiness" | "022_cliniko_catalogue_approvals" | "023_phone_index_credentials" | "034_greeting_setting_audit" | "035_cancellation_setting_audit" | "036_rescheduling_setting_audit" | "037_clinic_intake_setting" | "038_staffed_destination_setting_audit" | "039_clinic_notification_settings" | "040_clinic_voice_settings" | "041_admin_magic_link_identity" | "042_patient_verification_budget" | "043_clinic_patient_correction_setting" | "044_cliniko_contact_revision" | "045_cliniko_contact_change_registry"): Promise<void> {
  assertMigration(await createMigrator(db).migrateTo(target));
}
