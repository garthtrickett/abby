import { createHash } from "node:crypto";
import type { ActionRequest } from "./model.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function digestActionRequest(request: ActionRequest): string {
  return createHash("sha256").update(JSON.stringify(canonical(request))).digest("hex");
}

export function digestTurn(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
