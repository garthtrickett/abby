export type ClassServiceQuestion = Readonly<{
  operation: "book" | "cancel" | "reschedule";
  labels: readonly string[];
  page: number;
  pages: number;
  expiresAt: string;
}>;

/** Public class labels only. Choosing a service confers no patient authority. */
export function classServiceQuestionText(value: ClassServiceQuestion, now: string): string | undefined {
  if (!value || Object.keys(value).sort().join(",") !== "expiresAt,labels,operation,page,pages" ||
      !["book", "cancel", "reschedule"].includes(value.operation) || !Array.isArray(value.labels) || value.labels.length < 1 || value.labels.length > 3 ||
      !value.labels.every(label => typeof label === "string" && label.trim() === label && label.length > 0 && label.length <= 400 && !/[\u0000-\u001f\u007f]/.test(label)) ||
      new Set(value.labels).size !== value.labels.length || !Number.isSafeInteger(value.page) || !Number.isSafeInteger(value.pages) ||
      value.page < 1 || value.page > value.pages || value.pages > 11 || !Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.parse(now) || Date.parse(value.expiresAt) > Date.parse(now) + 120_000) return undefined;
  return `Which class service would you like to ${value.operation === "book" ? "book" : value.operation === "cancel" ? "cancel attendance for" : "move attendance for"}? ` +
    value.labels.map((label, index) => `Option ${index + 1}: ${label}.`).join(" ") +
    (value.pages > 1 ? ` This is page ${value.page} of ${value.pages}. You can ask for the next or previous class services.` : "");
}
