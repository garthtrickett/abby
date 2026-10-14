import type { PatientCodeDelivery } from "./email-patient-authority.ts";
import { SmtpTextMailTransport } from "./smtp-text-mail-transport.ts";
import type { SmtpMailConfig } from "./smtp-text-mail-transport.ts";

export type SmtpPatientCodeConfig = SmtpMailConfig;

/** Fixed verification message. This transports no appointment or patient facts.
 * Lost acceptance never verifies the caller and is never retried by this adapter. */
export class SmtpPatientCodeDelivery implements PatientCodeDelivery {
  readonly #transport: SmtpTextMailTransport;
  constructor(config: SmtpPatientCodeConfig) { this.#transport = new SmtpTextMailTransport(config); }
  async send(email: string, code: string, signal: AbortSignal): Promise<boolean> {
    if (!(signal instanceof AbortSignal) || signal.aborted || typeof code !== "string" || !/^[0-9]{6}$/.test(code)) return false;
    const result = await this.#transport.submit(email, "Your clinic verification code",
      `Verification code: ${code}\r\n\r\nEnter this code on the keypad during your current clinic call.`, signal);
    return result.kind === "accepted" && !signal.aborted;
  }
}
