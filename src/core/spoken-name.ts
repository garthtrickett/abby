export function normalizedSpokenName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80 || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-AU");
  return normalized && /^[\p{L}\p{N}](?:[\p{L}\p{N} .,'&-]*[\p{L}\p{N}])?$/u.test(normalized) ? normalized : undefined;
}

