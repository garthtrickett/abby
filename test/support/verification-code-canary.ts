import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

export type CanaryClockWindow = Readonly<{ sinceMs: number; throughMs: number }>;
const space = 1_000_000;
function validWindow(window: CanaryClockWindow): boolean {
  return Number.isSafeInteger(window.sinceMs) && Number.isSafeInteger(window.throughMs) && window.sinceMs > 0 &&
    window.throughMs >= window.sinceMs && window.throughMs - window.sinceMs <= 700_000;
}
/** A six-digit secret is an ambiguous substring canary if legitimate request
 * timestamps in this bounded fixture can also contain it. Check every decimal
 * position, including an interval that crosses a million-value rollover. */
export function distinctFromClock(code: number, window: CanaryClockWindow): boolean {
  if (!Number.isInteger(code) || code < 0 || code >= space || !validWindow(window)) return false;
  for (let divisor = 1; Math.floor(window.throughMs / divisor) >= 100_000; divisor *= 10) {
    const low = Math.floor(window.sinceMs / divisor), high = Math.floor(window.throughMs / divisor);
    if (high - low >= space - 1) return false;
    const start = low % space, end = high % space;
    if (Math.floor(low / space) === Math.floor(high / space) ? code >= start && code <= end : code >= start || code <= end) return false;
  }
  return true;
}
export function drawDistinctCode(draw: () => number, window: CanaryClockWindow): number {
  if (!validWindow(window)) throw Error("Invalid synthetic verification canary clock window");
  for (let attempt = 0; attempt < 256; attempt++) { const code = draw(); if (distinctFromClock(code, window)) return code; }
  throw Error("Synthetic verification canary selection exhausted");
}
let installed = false;
/** Test-process-only rejection sampling. Challenges still use the actual code
 * issuer, hash/salt, delivery and verification. Production crypto is untouched.
 * Every raw code remains subject to all-column and unfiltered backup scans. */
export function installStagedVerificationCanaries(): CanaryClockWindow {
  if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
      process.env.ABBY_SYNTHETIC_CLASS_QUOTA_STAGING !== "1" || process.env.ABBY_SYNTHETIC_CLINICAL_OPERATION !== "reschedule" ||
      process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5" || !process.env.DATABASE_URL?.includes("/abby_test_voice_"))
    throw Error("Verification canary sampling requires an isolated staged class fixture");
  return install();
}

/** The separately compiled clinical fixture uses the same unchanged issuer and
 * privacy scanner. Only its synthetic code draw is separated from public clocks. */
export function installClinicalVerificationCanaries(): CanaryClockWindow {
  if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
      process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5" || !process.env.DATABASE_URL?.includes("/abby_test_voice_") ||
      !["book", "cancel", "reschedule", "intake", "patientUpdate", "appointments.read", "staff.request"]
        .includes(process.env.ABBY_SYNTHETIC_CLINICAL_OPERATION ?? ""))
    throw Error("Verification canary sampling requires an isolated clinical fixture");
  return install();
}

export function installResendVerificationCanaries(): CanaryClockWindow {
  if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
      process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5" || !process.env.DATABASE_URL?.includes("/abby_test_voice_") ||
      process.env.ABBY_SYNTHETIC_CLINICAL_OPERATION !== "confirmationResend")
    throw Error("Verification canary sampling requires an isolated resend fixture");
  return install();
}

function install(): CanaryClockWindow {
  if (installed) throw Error("Synthetic verification canary sampling already installed");
  const now = Date.now(), window = Object.freeze({ sinceMs: now - 60_000, throughMs: now + 600_000 });
  const randomInt = crypto.randomInt, descriptor = Object.getOwnPropertyDescriptor(crypto, "randomInt");
  if (!descriptor?.writable) throw Error("Synthetic verification crypto is unavailable");
  Object.defineProperty(crypto, "randomInt", { ...descriptor, value: (...args: unknown[]) =>
    args.length === 2 && args[0] === 0 && args[1] === space
      ? drawDistinctCode(() => randomInt(0, space), window) : Reflect.apply(randomInt, crypto, args) });
  syncBuiltinESMExports(); installed = true;
  return window;
}
