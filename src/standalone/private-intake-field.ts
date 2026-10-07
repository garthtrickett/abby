export type PrivateIntakeField = "firstName" | "lastName" | "dateOfBirth" | "email";
export type PrivateFieldResult = Readonly<{ kind: "value" | "fragment"; value: string }> | Readonly<{ kind: "wait" | "reset" }>;
const alphabet = "alfa bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(" ");
const letters = new Map(alphabet.map((word, index) => [word, String.fromCharCode(65 + index)]));
letters.set("alpha", "A"); letters.set("juliet", "J"); letters.set("x-ray", "X");
const months = "january february march april may june july august september october november december".split(" ");
const validEmail = (value: string) => value.length <= 254 && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);

/** Decodes explicit letter spelling only. A letter and its phonetic word must agree. */
function spelling(text: string, mixed = false): Readonly<{ value: string; explicit: boolean }> | undefined {
 let invalid = false, paired = false;
 let value = text.replace(/\b([a-z])\s+(?:for|as in)\s+([a-z]+)\b/gi, (_all, letter: string, word: string) => {
  paired = true; if (letters.get(word.toLowerCase()) !== letter.toUpperCase()) invalid = true;
  return letter.toUpperCase();
 });
 if (invalid || /\b(?:for|as in)\b/i.test(value)) return undefined;
 const tokens = value.trim().split(/[\s,]+|(?<=[a-z])-(?=[a-z](?:[-,\s]|$))/i).filter(Boolean);
 const complete = tokens.every(token => /^[a-z]$/i.test(token) || letters.has(token.toLowerCase()));
 if (paired && !complete && !mixed) return undefined;
 const explicit = paired || tokens.length >= 2 && complete;
 if (complete && explicit) value = tokens.map(token => /^[a-z]$/i.test(token) ? token.toUpperCase() : letters.get(token.toLowerCase()) ?? token).join("");
 return { value, explicit };
}
function date(text: string): string | undefined {
 let year: string, month: string, day: string;
 const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
 const numeric = /^(\d{1,2})[ /-](\d{1,2})[ /-](\d{4})$/.exec(text) ?? /^(\d{2})(\d{2})(\d{4})$/.exec(text);
 const named = /^(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i.exec(text);
 if (iso) { year = iso[1]!; month = iso[2]!; day = iso[3]!; }
 else if (numeric) { day = numeric[1]!; month = numeric[2]!; year = numeric[3]!; }
 else if (named) { day = named[1]!; month = String(months.indexOf(named[2]!.toLowerCase()) + 1); year = named[3]!; }
 else return undefined;
 const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
 const at = new Date(`${value}T00:00:00.000Z`);
 return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value ? value : undefined;
}
function emailPart(text: string): string | undefined {
 // A compact address is already literal; preserve its hyphens and word names.
 if (validEmail(text)) return text.toLowerCase();
 const decoded = spelling(text, true); if (!decoded) return undefined;
 let value = decoded.value;
 // Decode NATO runs inside a spoken address, without changing literal words
 // in domains or a compact address. Unknown words remain literal characters.
 const phonetic = [...letters.keys()].join("|");
 value = value.replace(new RegExp(`\\b(?:${phonetic})(?:[ ,]+(?:${phonetic}))+\\b`, "gi"), run => spelling(run)!.value);
 value = value.replace(/\b(?:at|dot|underscore|dash|hyphen|plus)\b/gi, word => ({ at: "@", dot: ".", underscore: "_", dash: "-", hyphen: "-", plus: "+" })[word.toLowerCase()]!);
 value = value.replace(/(?<=\b[a-z])-(?=[a-z](?:-|\b))/gi, "").replace(/[\s,]+/g, "").toLowerCase();
 return /^[a-z0-9._%+@-]+$/.test(value) ? value : undefined;
}
/** Private field finals only: no inference, patient lookup or authority. Fragments
 * remain in the private input owner and require an explicit continuation. */
export function privateIntakeField(field: PrivateIntakeField, text: string, fragment?: string): PrivateFieldResult | undefined {
 if (typeof text !== "string" || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
 let value = text.trim().replace(/[.!?]$/, "").trim();
 if (/^(?:please )?(?:hold|wait|hold on|give me a moment|all lowercase)$/i.test(value)) return { kind: "wait" };
 if (/^(?:yes|no|thanks|thank you|okay|go ahead)$/i.test(value)) return undefined;
 const replacing = /^(?:actually|sorry|no)[,:]\s*/i.test(value);
 value = value.replace(/^(?:actually|sorry|no)[,:]\s*/i, "").replace(/^(?:it is |it's )?spelled\s+/i, "");
 if (field === "dateOfBirth") { const result = date(value); return result ? { kind: "value", value: result } : undefined; }
 if (field === "firstName" || field === "lastName") {
  const result = spelling(value); if (!result) return undefined;
  return /^[\p{L}][\p{L}\p{M} '-]{0,99}$/u.test(result.value) ? { kind: "value", value: result.value } : undefined;
 }
 const continuing = /^continue\s+/i.test(value);
 value = value.replace(/^continue\s+/i, "");
 if (continuing && (!fragment || replacing)) return undefined;
 const part = emailPart(value); if (!part) return replacing && fragment ? { kind: "reset" } : undefined;
 const candidate = `${continuing ? fragment : ""}${part}`;
 if (validEmail(candidate)) return { kind: "value", value: candidate };
 // Incomplete explicit spelling is retained, never a partial address guess.
 if (!candidate.includes("@") && candidate.length <= 128 && (spelling(value)?.explicit || /^[A-Z]$/.test(value))) return { kind: "fragment", value: candidate };
 return replacing && fragment ? { kind: "reset" } : undefined;
}
