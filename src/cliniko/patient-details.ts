import { createHash } from "node:crypto";
import { normalizeEmailAddress } from "../shared/email-address.ts";

export const patientDetailFields = ["first_name", "last_name", "date_of_birth", "email", "patient_phone_numbers",
  "address_1", "address_2", "address_3", "city", "state", "post_code", "country_code"] as const;
export type PatientDetailField = typeof patientDetailFields[number];
export type PatientPhone = Readonly<{ number: string; phone_type: "Fax" | "Home" | "Mobile" | "Other" | "Work" }>;
export type PatientDetails = Readonly<{
  first_name: string; last_name: string; date_of_birth: string | null; email: string | null;
  patient_phone_numbers: readonly PatientPhone[];
  address_1: string | null; address_2: string | null; address_3: string | null; city: string | null;
  state: string | null; post_code: string | null; country_code: string | null;
}>;
export type PatientDetailChanges = Readonly<Partial<PatientDetails>>;
export type PatientDetailsSnapshot = Readonly<{ patientId: string; updatedAt: string; details: PatientDetails }>;
const text = (value: unknown, max: number) => typeof value === "string" && !!value.trim() && value.trim() === value && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);
const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const instant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  date(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function field(key: PatientDetailField, value: unknown): boolean {
  if (key === "first_name" || key === "last_name") return text(value, key === "first_name" ? 50 : 255);
  if (key === "email") return value === null || typeof value === "string" && normalizeEmailAddress(value) === value;
  if (key === "date_of_birth") return value === null || date(value);
  if (key === "patient_phone_numbers") return Array.isArray(value) && value.length <= 20 && value.every(phone => object(phone) &&
    Object.keys(phone).sort().join(",") === "number,phone_type" && text(phone.number, 50) && typeof phone.phone_type === "string" && ["Fax", "Home", "Mobile", "Other", "Work"].includes(phone.phone_type));
  if (key === "country_code") return value === null || typeof value === "string" && /^[A-Z]{2}$/.test(value);
  return value === null || text(value, key === "post_code" ? 32 : 255);
}
export function validPatientDetailChanges(value: unknown): value is PatientDetailChanges {
  if (!object(value) || Object.keys(value).length < 1 || Object.keys(value).length > patientDetailFields.length) return false;
  return Object.entries(value).every(([key, value]) => patientDetailFields.includes(key as PatientDetailField) && field(key as PatientDetailField, value));
}

/** Only contact/identity fields are retained. Chart, billing and communication
 * preferences are neither writable here nor copied into the transient snapshot. */
export function patientDetailsSnapshot(value: unknown, patientId: string, baseUrl: string): PatientDetailsSnapshot | undefined {
  if (!object(value) || value.id !== patientId || value.archived_at !== null || value.merged_at !== null ||
      !instant(value.updated_at) ||
      !object(value.links) || value.links.self !== `${baseUrl}/patients/${patientId}`) return undefined;
  const details: Record<string, unknown> = {};
  for (const key of patientDetailFields) {
    const input = value[key];
    if (key === "patient_phone_numbers") {
      if (!Array.isArray(input)) return undefined;
      details[key] = input.map(phone => object(phone) ? { number: phone.number, phone_type: phone.phone_type } : null);
    } else details[key] = key === "email" && input !== null ? normalizeEmailAddress(input) : input;
    if (!field(key, details[key])) return undefined;
  }
  return { patientId, updatedAt: value.updated_at, details: details as PatientDetails };
}
export function patientDetailsDigest(snapshot: PatientDetailsSnapshot): string {
  return createHash("sha256").update(JSON.stringify([snapshot.patientId, snapshot.updatedAt,
    patientDetailFields.map(key => [key, snapshot.details[key]])])).digest("hex");
}
export function patientDetailChangesDigest(changes: PatientDetailChanges): string {
  return createHash("sha256").update(JSON.stringify(patientDetailFields.filter(key => Object.hasOwn(changes, key)).map(key => [key, changes[key]]))).digest("hex");
}
