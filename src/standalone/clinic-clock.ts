/** The approved Cliniko business zone owns caller-facing calendar dates. */
export function clinicDateAt(timeZone: string, instant: Date): string {
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(clock.formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** First UTC millisecond of an approved clinic calendar day, including DST days. */
export function clinicDayStartUtc(timeZone: string, date: string): string {
  const midnight = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight) ||
      new Date(midnight).toISOString().slice(0, 10) !== date) throw new TypeError("invalid clinic date");
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const localDate = (millis: number) => {
    const parts = Object.fromEntries(clock.formatToParts(new Date(millis)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  let before = midnight - 2 * 86_400_000, onOrAfter = midnight + 2 * 86_400_000;
  while (onOrAfter - before > 1) {
    const middle = Math.floor((before + onOrAfter) / 2);
    if (localDate(middle) < date) before = middle;
    else onOrAfter = middle;
  }
  if (localDate(onOrAfter) !== date) throw new TypeError("clinic date unavailable");
  return new Date(onOrAfter).toISOString();
}
