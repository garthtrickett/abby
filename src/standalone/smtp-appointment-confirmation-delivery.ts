import { normalizeEmailAddress } from "../shared/email-address.ts";
import { SmtpTextMailTransport } from "./smtp-text-mail-transport.ts";
import type { SmtpMailConfig, SmtpMailSubmission } from "./smtp-text-mail-transport.ts";

/** Private host data. The resend owner supplies a currently verified registered
 * recipient and freshly read, independently approved appointment details.
 * This DTO must never be a model tool argument, public action or stored call state. */
export type ConfirmationContentKind = "activeInPerson" | "activeTelehealth" | "cancelled";
export type ConfirmationTemplate = "appointmentDetails.v1" | "appointmentDetails.v2";
type ConfirmationMailBase = Readonly<{
  email: string; startsAt: string; endsAt: string; timeZone: string;
  clinicName: string; locationName: string;
  practitionerName: string; appointmentTypeName: string;
}>;
export type AppointmentConfirmationMail = ConfirmationMailBase & (
  | Readonly<{ locationAddress: string; contentKind?: never }>
  | Readonly<{ contentKind: "activeInPerson"; locationAddress: string }>
  | Readonly<{ contentKind: "activeTelehealth"; patientJoinUrl: string }>
  | Readonly<{ contentKind: "cancelled"; cancelledAt: string }>
);
/** Cliniko patient links are capabilities. Accept only the documented patient route, never the staff connect route. */
export function validPatientJoinUrl(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cliniko\.com\/c\/[A-Za-z0-9_-]{1,256}$/.test(value);
}
export interface AppointmentConfirmationDelivery {
  /** Transport acceptance only. Permission, played consent, durable send fencing
   * and unresolved-send review belong to the resend owner, not this adapter. */
  send(message: AppointmentConfirmationMail, signal: AbortSignal, submissionRef?: string): Promise<SmtpMailSubmission>;
}
/** Private host readback only. This must not be returned by a model tool or stored in SAM. */
export function appointmentConfirmationText(message: AppointmentConfirmationMail): string | undefined { return render(message)?.text; }
const labels = ["clinicName", "locationName", "practitionerName", "appointmentTypeName"] as const;
const fields = ["email", "startsAt", "endsAt", "timeZone", ...labels];
function instant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z");
}
function render(value: unknown): Readonly<{ email: string; text: string }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const variant = row.contentKind === undefined ? ["locationAddress"] : row.contentKind === "activeInPerson" ? ["contentKind", "locationAddress"] :
    row.contentKind === "activeTelehealth" ? ["contentKind", "patientJoinUrl"] : row.contentKind === "cancelled" ? ["contentKind", "cancelledAt"] : undefined;
  if (!variant || Object.keys(row).sort().join(",") !== [...fields, ...variant].sort().join(",") || typeof row.email !== "string" || normalizeEmailAddress(row.email) !== row.email ||
      labels.some(key => typeof row[key] !== "string" || row[key].trim() !== row[key] || !row[key].length || row[key].length > 255 || /[\p{Cc}\p{Cf}]/u.test(row[key])) ||
      !instant(row.startsAt) || !instant(row.endsAt) || typeof row.timeZone !== "string" || row.timeZone.length > 100) return undefined;
  if (row.contentKind === "activeTelehealth" ? !validPatientJoinUrl(row.patientJoinUrl) : row.contentKind === "cancelled" ? !instant(row.cancelledAt) :
      typeof row.locationAddress !== "string" || row.locationAddress.trim() !== row.locationAddress || !row.locationAddress.length ||
      row.locationAddress.length > 255 || /[\p{Cc}\p{Cf}]/u.test(row.locationAddress)) return undefined;
  const duration = (Date.parse(row.endsAt) - Date.parse(row.startsAt)) / 60_000;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 480) return undefined;
  try {
    const at = new Date(row.startsAt), timeZone = row.timeZone;
    const date = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(at);
    const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    const status = row.contentKind === "cancelled" ? ["Cancelled appointment details", "Status: Cancelled. This appointment is no longer booked.", `Cancelled at: ${row.cancelledAt}`] :
      row.contentKind === "activeTelehealth" ? ["Appointment details", "Attendance: Telehealth. Attend online using the patient link below."] : ["Appointment details"];
    const attendance = row.contentKind === "cancelled" ? [] : row.contentKind === "activeTelehealth" ? [`Patient join link: ${row.patientJoinUrl}`] : [`Address: ${row.locationAddress}`];
    return { email: row.email, text: [...status, `Clinic: ${row.clinicName}`, `Location: ${row.locationName}`,
      ...attendance, `Date: ${date}`, `Time: ${time} (${timeZone})`, `Duration: ${duration} minutes`,
      `Practitioner: ${row.practitionerName}`, `Appointment: ${row.appointmentTypeName}`].join("\r\n") };
  } catch { return undefined; }
}

/** Fixed appointment-content adapter; it cannot create/change an appointment,
 * send a verification code, alter notification ownership or infer native delivery.
 * It never retries a failed or uncertain SMTP submission. */
export class SmtpAppointmentConfirmationDelivery implements AppointmentConfirmationDelivery {
  readonly #transport: SmtpTextMailTransport;
  readonly #sender: string;
  readonly #template: ConfirmationTemplate;
  constructor(config: SmtpMailConfig, template: ConfirmationTemplate = "appointmentDetails.v1") {
    if (!["appointmentDetails.v1", "appointmentDetails.v2"].includes(template)) throw new TypeError("invalid confirmation template");
    this.#template = template; this.#transport = new SmtpTextMailTransport(config); this.#sender = config.from; }
  selection() { return { sender: this.#sender, template: this.#template }; }
  async send(message: AppointmentConfirmationMail, signal: AbortSignal, submissionRef?: string): Promise<SmtpMailSubmission> {
    const prepared = (this.#template === "appointmentDetails.v1") === (message?.contentKind === undefined) ? render(message) : undefined;
    return prepared ? this.#transport.submit(prepared.email, message.contentKind === "cancelled" ? "Your cancelled appointment details" : "Your appointment details", prepared.text, signal, submissionRef) : { kind: "definitiveUnsent" };
  }
}
