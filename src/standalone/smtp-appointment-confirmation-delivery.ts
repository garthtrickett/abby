import { normalizeEmailAddress } from "../shared/email-address.ts";
import { SmtpTextMailTransport } from "./smtp-text-mail-transport.ts";
import type { SmtpMailConfig, SmtpMailSubmission } from "./smtp-text-mail-transport.ts";

/** Private host data. The resend owner supplies a currently verified registered
 * recipient and freshly read, independently approved appointment details.
 * This DTO must never be a model tool argument, public action or stored call state. */
export type AppointmentConfirmationMail = Readonly<{
  email: string; startsAt: string; endsAt: string; timeZone: string;
  clinicName: string; locationName: string; locationAddress: string;
  practitionerName: string; appointmentTypeName: string;
}>;
export interface AppointmentConfirmationDelivery {
  /** Transport acceptance only. Permission, played consent, durable send fencing
   * and unresolved-send review belong to the resend owner, not this adapter. */
  send(message: AppointmentConfirmationMail, signal: AbortSignal): Promise<SmtpMailSubmission>;
}
const labels = ["clinicName", "locationName", "locationAddress", "practitionerName", "appointmentTypeName"] as const;
const fields = ["email", "startsAt", "endsAt", "timeZone", ...labels].sort().join(",");
function instant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z");
}
function render(value: unknown): Readonly<{ email: string; text: string }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== fields || typeof row.email !== "string" || normalizeEmailAddress(row.email) !== row.email ||
      labels.some(key => typeof row[key] !== "string" || row[key].trim() !== row[key] || !row[key].length || row[key].length > 255 || /[\p{Cc}\p{Cf}]/u.test(row[key])) ||
      !instant(row.startsAt) || !instant(row.endsAt) || typeof row.timeZone !== "string" || row.timeZone.length > 100) return undefined;
  const duration = (Date.parse(row.endsAt) - Date.parse(row.startsAt)) / 60_000;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 480) return undefined;
  try {
    const at = new Date(row.startsAt), timeZone = row.timeZone;
    const date = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(at);
    const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    return { email: row.email, text: ["Appointment details", `Clinic: ${row.clinicName}`, `Location: ${row.locationName}`,
      `Address: ${row.locationAddress}`, `Date: ${date}`, `Time: ${time} (${timeZone})`, `Duration: ${duration} minutes`,
      `Practitioner: ${row.practitionerName}`, `Appointment: ${row.appointmentTypeName}`].join("\r\n") };
  } catch { return undefined; }
}

/** Fixed appointment-content adapter; it cannot create/change an appointment,
 * send a verification code, alter notification ownership or infer native delivery.
 * It never retries a failed or uncertain SMTP submission. */
export class SmtpAppointmentConfirmationDelivery implements AppointmentConfirmationDelivery {
  readonly #transport: SmtpTextMailTransport;
  constructor(config: SmtpMailConfig) { this.#transport = new SmtpTextMailTransport(config); }
  async send(message: AppointmentConfirmationMail, signal: AbortSignal): Promise<SmtpMailSubmission> {
    const prepared = render(message);
    return prepared ? this.#transport.submit(prepared.email, "Your appointment details", prepared.text, signal) : { kind: "definitiveUnsent" };
  }
}
