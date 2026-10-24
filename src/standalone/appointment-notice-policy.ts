import type { AppointmentChangeTerms } from "../core/model.ts";
import { approvalInstant, approvalRef } from "./owner-file-clinic-approval.ts";

export type NoticeTerms = Readonly<{ version: string; approvedText: string }>;
export type AppointmentNoticeRange = Readonly<{
  withinHours: number;
  handling: "automatic" | "staffReview";
  terms: NoticeTerms;
}>;
export type AppointmentNoticePolicy = Readonly<{
  lateNoticeHours: number; maxAdvanceDays: number;
  standardTerms: NoticeTerms; lateTerms: NoticeTerms;
  effectiveFrom: string; effectiveUntil: string;
  noticeRanges?: readonly AppointmentNoticeRange[];
}>;

/** Ranges are optional clinic configuration, never inferred from a fee or reason.
 * The narrowest matching window wins; ordering in the file is immaterial. */
export function validNoticeRanges(value: unknown, standardVersion: string, maxTextLength: number): value is readonly AppointmentNoticeRange[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return false;
  const hours = new Set<number>(), versions = new Set<string>([standardVersion]);
  for (const range of value) {
    if (!range || typeof range !== "object" || Array.isArray(range) ||
        Object.keys(range).sort().join(",") !== "handling,terms,withinHours" ||
        !Number.isSafeInteger(range.withinHours) || range.withinHours < 1 || range.withinHours > 168 || hours.has(range.withinHours) ||
        !["automatic", "staffReview"].includes(range.handling) || !range.terms || typeof range.terms !== "object" || Array.isArray(range.terms) ||
        Object.keys(range.terms).sort().join(",") !== "approvedText,version" || !approvalRef(range.terms.version) || versions.has(range.terms.version) ||
        typeof range.terms.approvedText !== "string" || !range.terms.approvedText.trim() || range.terms.approvedText.length > maxTextLength ||
        /[\u0000-\u001f\u007f]/.test(range.terms.approvedText)) return false;
    hours.add(range.withinHours); versions.add(range.terms.version);
  }
  return true;
}

/** No terms means no automatic clinical effect. A staffReview window does not
 * save a request or establish that any member of staff has received one. */
export function appointmentNoticeTerms(policy: AppointmentNoticePolicy, startsAt: string, now: string): AppointmentChangeTerms | undefined {
  const start = approvalInstant(startsAt), at = approvalInstant(now);
  if (start === undefined || at === undefined) return undefined;
  const notice = start - at;
  if (notice <= 0 || notice > policy.maxAdvanceDays * 86_400_000 ||
      at < Date.parse(policy.effectiveFrom) || at >= Date.parse(policy.effectiveUntil)) return undefined;
  let selected: NoticeTerms;
  if (policy.noticeRanges !== undefined) {
    // Do not mutate the captured source or rely on Array.sort's input order.
    const range = policy.noticeRanges.reduce<AppointmentNoticeRange | undefined>((found, candidate) =>
      notice < candidate.withinHours * 3_600_000 && (!found || candidate.withinHours < found.withinHours) ? candidate : found, undefined);
    if (range?.handling === "staffReview") return undefined;
    selected = range?.terms ?? policy.standardTerms;
  } else selected = notice < policy.lateNoticeHours * 3_600_000 ? policy.lateTerms : policy.standardTerms;
  return { ...selected, expiresAt: policy.effectiveUntil };
}
