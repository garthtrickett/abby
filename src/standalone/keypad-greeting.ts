export const keypadInstructions = "Press 1 for possible times today. Press 2 for possible times tomorrow.";
export const sevenDayInstructions = "Press 3 for possible times over the next week.";

/** Keep setup-time approval and call-time admission on the same spoken menu contract. */
export function validKeypadGreetingText(text: unknown, sevenDayEnabled: boolean): text is string {
  return typeof text === "string" && text.includes(keypadInstructions) &&
    text.includes(sevenDayInstructions) === sevenDayEnabled;
}
