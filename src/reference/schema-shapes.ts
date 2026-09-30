/** The small JSON Schema subset used for host-agent command contracts. */
export type JsonSchema = Readonly<{
  $schema?: string;
  type?: "object" | "array" | "string" | "integer" | "boolean";
  const?: string | number | boolean | null;
  enum?: readonly (string | number | boolean)[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  oneOf?: readonly JsonSchema[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  pattern?: string;
}>;

export const str: JsonSchema = { type: "string" };
export const key: JsonSchema = { type: "string", minLength: 1, maxLength: 256 };
export const bool: JsonSchema = { type: "boolean" };
export const uint: JsonSchema = { type: "integer", minimum: 0 };
export const choice = (...values: string[]): JsonSchema => ({ enum: values });
export const array = (items: JsonSchema): JsonSchema => ({ type: "array", items });
export const object = (properties: Record<string, JsonSchema>, required: readonly string[] = Object.keys(properties), additionalProperties = false): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties });

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Validates this declared subset; unsupported keywords are not accepted in catalogue schemas. */
export function matchesSchema(schema: JsonSchema, value: unknown): boolean {
  if (schema.oneOf && schema.oneOf.filter(option => matchesSchema(option, value)).length !== 1) return false;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) return false;
  if (schema.type === "string") {
    if (typeof value !== "string" || (schema.minLength !== undefined && value.length < schema.minLength) ||
        (schema.maxLength !== undefined && value.length > schema.maxLength) ||
        (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))) return false;
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") return false;
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value) || (schema.minimum !== undefined && Number(value) < schema.minimum) ||
        (schema.maximum !== undefined && Number(value) > schema.maximum)) return false;
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || (schema.minItems !== undefined && value.length < schema.minItems) ||
        (schema.maxItems !== undefined && value.length > schema.maxItems)) return false;
    if (schema.uniqueItems) {
      try { if (new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false; }
      catch { return false; }
    }
    if (schema.items && value.some(item => !matchesSchema(schema.items!, item))) return false;
  } else if (schema.type === "object") {
    const data = record(value);
    if (!data || schema.required?.some(field => !Object.hasOwn(data, field)) ||
        (schema.additionalProperties === false && Object.keys(data).some(field => !(field in (schema.properties ?? {}))))) return false;
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(data, field) && !matchesSchema(fieldSchema, data[field])) return false;
    }
  }
  return true;
}
