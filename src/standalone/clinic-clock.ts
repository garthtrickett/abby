/** The approved Cliniko business zone owns caller-facing calendar dates. */
export function clinicDateAt(timeZone: string, instant: Date): string {
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(clock.formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
