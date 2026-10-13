import { normalizedSpokenName } from "./pending-location.ts";

export type BookingServiceQuestion = Readonly<{ field: "name" | "visitKind" | "durationMinutes" | "returningPatient" | "newProblem" | "monthsSinceLastVisit"; options: readonly string[] }>;

/** Public questions contain no provider identifiers or caller history. */
export function bookingServiceQuestionText(value: BookingServiceQuestion): string | undefined {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "field,options" || !Array.isArray(value.options) ||
      value.options.length > 12 || new Set(value.options).size !== value.options.length) return undefined;
  const options = value.options;
  switch (value.field) {
    case "name": return options.length && options.every(name => normalizedSpokenName(name))
      ? `Which service would you like? The approved choices are ${options.join(", ")}.` : undefined;
    case "visitKind": return options.length && options.every(kind => kind === "initial" || kind === "followUp")
      ? `Would you like ${options.map(kind => kind === "initial" ? "an initial assessment" : "a follow-up appointment").join(" or ")}?` : undefined;
    case "durationMinutes": return options.length && options.every(duration => /^[1-9]\d{0,2}$/.test(duration) && Number(duration) <= 480)
      ? `What appointment length would you like? The approved lengths are ${options.join(" or ")} minutes.` : undefined;
    case "returningPatient": return options.length === 0 ? "Have you attended this clinic before?" : undefined;
    case "newProblem": return options.length === 0 ? "Is this appointment for a new problem?" : undefined;
    case "monthsSinceLastVisit": return options.length === 0 ? "How many months ago was your last visit?" : undefined;
    default: return undefined;
  }
}
