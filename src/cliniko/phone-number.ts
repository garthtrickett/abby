/** Conservative international form for caller ID and Cliniko patient numbers. */
export function normalizePatientPhone(input: string, countryCallingCode: string): string | undefined {
  if (typeof input !== "string" || typeof countryCallingCode !== "string" ||
      !/^[1-9][0-9]{0,2}$/.test(countryCallingCode) || input.length > 64 ||
      !/^\+?[0-9().\s-]+$/.test(input.trim())) return undefined;
  const compact = input.replace(/[().\s-]/g, "");
  let digits: string;
  if (compact.startsWith("+")) digits = compact.slice(1);
  else if (compact.startsWith("0") && !compact.startsWith("00")) digits = countryCallingCode + compact.slice(1);
  else return undefined;
  return /^[1-9][0-9]{7,14}$/.test(digits) ? `+${digits}` : undefined;
}
