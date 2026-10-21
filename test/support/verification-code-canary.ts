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
export function drawDistinctCode(draw: () => number, window: CanaryClockWindow, excluded: ReadonlySet<string> = new Set()): number {
  return drawCode(draw, window, excluded, 256, () => true);
}
/** PostgreSQL renders microseconds without trailing zeroes. Six-digit canaries
 * ending in zero cannot equal a complete rendered timestamp fraction. Keep the
 * epoch-window and existing-row exclusions as separate requirements. */
export function drawSqlCanaryCode(draw: () => number, window: CanaryClockWindow, excluded: ReadonlySet<string> = new Set()): number {
  return drawCode(draw, window, excluded, 4096, code => code % 10 === 0);
}
function drawCode(draw: () => number, window: CanaryClockWindow, excluded: ReadonlySet<string>, attempts: number,
  eligible: (code: number) => boolean): number {
  if (!validWindow(window) || !(excluded instanceof Set) || excluded.size > 100000 || [...excluded].some(v => !/^[0-9]{6}$/.test(v)))
    throw Error("Invalid synthetic verification canary clock window or exclusions");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const code = draw(); if (distinctFromClock(code, window) && eligible(code) && !excluded.has(String(code).padStart(6, "0"))) return code;
  }
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

/** Restrict direct SQL instrumentation to its actual isolated Node test child.
 * The production runtime and other test workers never acquire this override. */
export function assertDirectSqlVerificationCanaryContext(): void {
  const entry = process.argv[1]?.replaceAll("\\", "/"), eligible = [
    "postgres-outbound-clinical-cancellation.test.ts", "postgres-outbound-clinical-rescheduling.test.ts",
    "postgres-outbound-clinical-voice.test.ts", "postgres-outbound-follow-up-financial.test.ts",
    "postgres-representative-booking-memo.test.ts",
    "postgres-outbound-administrative-memo.test.ts",
  ];
  let database: URL | undefined;
  try { database = new URL(process.env.DATABASE_URL ?? "https://invalid.local"); } catch { /* Generic guard error below. */ }
  if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.NODE_TEST_CONTEXT !== "child-v8" ||
      !eligible.some(file => entry?.endsWith("/test/storage/" + file)) || !["postgres:", "postgresql:"].includes(database?.protocol ?? "") ||
      !["localhost", "127.0.0.1"].includes(database?.hostname ?? "") ||
      !(database?.pathname === "/postgres" || database?.pathname.startsWith("/abby_test_")))
    throw Error("Verification canary sampling requires an isolated direct SQL fixture");
}
export function installDirectSqlVerificationCanaries(excluded: ReadonlySet<string>): CanaryClockWindow {
  assertDirectSqlVerificationCanaryContext();
  if (!(excluded instanceof Set) || excluded.size > 100000 || [...excluded].some(v => !/^[0-9]{6}$/.test(v)))
    throw Error("Invalid synthetic prior-clock canary exclusions");
  return install(new Set(excluded));
}

function install(excluded: ReadonlySet<string> = new Set()): CanaryClockWindow {
  if (installed) throw Error("Synthetic verification canary sampling already installed");
  const now = Date.now(), window = Object.freeze({ sinceMs: now - 60_000, throughMs: now + 600_000 });
  const randomInt = crypto.randomInt, descriptor = Object.getOwnPropertyDescriptor(crypto, "randomInt");
  if (!descriptor?.writable) throw Error("Synthetic verification crypto is unavailable");
  Object.defineProperty(crypto, "randomInt", { ...descriptor, value: (...args: unknown[]) =>
    args.length === 2 && args[0] === 0 && args[1] === space
      ? drawSqlCanaryCode(() => randomInt(0, space), window, excluded) : Reflect.apply(randomInt, crypto, args) });
  syncBuiltinESMExports(); installed = true;
  return window;
}
