import { validRecallDate } from "../recall-note.ts";

/** Native ISO timestamp -> caller-facing millisecond instant. Source/version
 * hashes must retain the original native bytes, including sub-millisecond data. */
export function clinikoNativeInstant(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40 || !validRecallDate(value.slice(0, 10)) ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return undefined;
  const n = Date.parse(value); return Number.isFinite(n) ? new Date(n).toISOString() : undefined;
}

export function clinikoNativeTime(value: unknown): number | undefined {
  const at = clinikoNativeInstant(value); return at === undefined ? undefined : Date.parse(at);
}
