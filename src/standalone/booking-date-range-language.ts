const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const named = `(?:${months.join("|")})`;
const token = `(?:\\d{4}-\\d{2}-\\d{2}|${named} \\d{1,2}(?:st|nd|rd|th)?(?: \\d{4})?|\\d{1,2}(?:st|nd|rd|th)? ${named}(?: \\d{4})?)`;
function date(text: string, today: string): string | undefined {
  const first = text.match(new RegExp(`^(${named}) (\\d{1,2})(?:st|nd|rd|th)?(?: (\\d{4}))?$`));
  const last = text.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)? (${named})(?: (\\d{4}))?$`));
  const month = first?.[1] ?? last?.[2], day = first?.[2] ?? last?.[1], year = first?.[3] ?? last?.[3] ?? today.slice(0, 4);
  const value = month && day ? `${year}-${String(months.indexOf(month) + 1).padStart(2, "0")}-${day.padStart(2, "0")}` : text;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? value : undefined;
}
/** Explicit calendar pairs do not become clock bounds or slot ordinals.
 * The current clinic approval owns the permitted span; prior time filters remain. */
export function bookingDateRangeLanguage(text: string, today: string) {
  const value = text.toLowerCase().trim().replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(?:please |could you |can you )/, "").replace(/^(?:show|find|look for|check) (?:me )?(?:appointments|times|availability) /, "")
    .replace(/^what (?:appointments|times|availability) (?:are available |do you have )?/, "").replace(/ please$/, "");
  const match = value.match(new RegExp(`^(?:between (${token}) and (${token})|from (${token}) (?:to|until|through) (${token}))$`));
  if (!match) return undefined;
  const from = date(match[1] ?? match[3]!, today), to = date(match[2] ?? match[4]!, today);
  return from && to && from >= today && to >= from ? { kind: "range" as const, from, to } : { kind: "ambiguous" as const };
}
