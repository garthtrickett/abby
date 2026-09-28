import type { ModelInput, RawModelPort } from "./proposal.ts";

const ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_RESPONSE_BYTES = 64 * 1024;

const nullableString = { type: ["string", "null"] } as const;
const proposalSchema = {
  type: "object",
  properties: {
    proposal: {
      anyOf: [
        { type: "object", additionalProperties: false,
          properties: { schemaVersion: { type: "integer", enum: [1] }, kind: { type: "string", enum: ["answer"] },
            sourceRefs: { type: "array", items: { type: "string" } }, proposedText: { type: "string" } },
          required: ["schemaVersion", "kind", "sourceRefs", "proposedText"] },
        { type: "object", additionalProperties: false,
          properties: { schemaVersion: { type: "integer", enum: [1] }, kind: { type: "string", enum: ["lookup"] },
            target: { type: "string", enum: ["patient", "appointment", "offer"] },
            statedName: nullableString, statedDate: nullableString, requestedService: nullableString,
            requestedLocationId: nullableString },
          required: ["schemaVersion", "kind", "target", "statedName", "statedDate", "requestedService", "requestedLocationId"] },
        { type: "object", additionalProperties: false,
          properties: { schemaVersion: { type: "integer", enum: [1] }, kind: { type: "string", enum: ["action"] },
            operation: { type: "string", enum: ["intake", "book", "cancel", "reschedule"] },
            targetRef: nullableString, requestedService: nullableString, requestedTime: nullableString },
          required: ["schemaVersion", "kind", "operation", "targetRef", "requestedService", "requestedTime"] },
        { type: "object", additionalProperties: false,
          properties: { schemaVersion: { type: "integer", enum: [1] }, kind: { type: "string", enum: ["handoff"] },
            reason: { type: "string", enum: ["callerRequested", "unsupported"] } },
          required: ["schemaVersion", "kind", "reason"] },
      ],
    },
  },
  required: ["proposal"],
  additionalProperties: false,
} as const;

export type OpenAIResponsesPortConfig = Readonly<{
  apiKey: string;
  model: string;
  promptVersion: string;
  instructions: string;
  fetch?: typeof fetch;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); return undefined; }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return undefined; }
}

function extractProposal(raw: unknown): unknown {
  const response = record(raw);
  if (response?.status !== "completed" || !Array.isArray(response.output)) return undefined;
  const items = response.output.map(record);
  if (items.some(item => !item || (item.type !== "reasoning" && item.type !== "message"))) return undefined;
  const messages = items.filter(item => item?.type === "message");
  if (messages.length !== 1 || messages[0]?.status !== "completed" || !Array.isArray(messages[0].content) ||
      messages[0].content.length !== 1) return undefined;
  const content = record(messages[0].content[0]);
  if (content?.type !== "output_text" || typeof content.text !== "string" || content.text.length > MAX_RESPONSE_BYTES) return undefined;
  let envelope: Record<string, unknown> | undefined;
  try { envelope = record(JSON.parse(content.text)); }
  catch { return undefined; }
  if (!envelope || Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, "proposal")) return undefined;
  const proposal = record(envelope.proposal);
  if (!proposal) return undefined;
  // Structured Outputs requires nullable optional fields; the domain proposal omits them.
  return Object.fromEntries(Object.entries(proposal).filter(([, value]) => value !== null));
}

/** Opt-in provider adapter. The typed ingress still validates every returned proposal. */
export class OpenAIResponsesPort implements RawModelPort {
  private readonly config: OpenAIResponsesPortConfig;
  private readonly fetchPort: typeof fetch;

  constructor(config: OpenAIResponsesPortConfig) {
    if (!config.apiKey.trim() || /[\r\n]/.test(config.apiKey) || !config.model.trim() || config.model.length > 256 ||
        !config.promptVersion.trim() || config.promptVersion.length > 128 ||
        !config.instructions.trim() || config.instructions.length > 10_000) throw new Error("invalid model port configuration");
    this.config = config;
    this.fetchPort = config.fetch ?? fetch;
  }

  async propose(input: ModelInput, signal: AbortSignal): Promise<unknown> {
    if (input.promptVersion !== this.config.promptVersion || signal.aborted) throw new Error("model request unavailable");
    const response = await this.fetchPort(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        input: [
          { role: "system", content: this.config.instructions },
          { role: "user", content: input.turn.text },
        ],
        text: { format: { type: "json_schema", name: "abby_model_proposal_v1", strict: true, schema: proposalSchema } },
        store: false,
        max_output_tokens: 512,
        tool_choice: "none",
        truncation: "disabled",
      }),
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error("model request unavailable");
    return extractProposal(await boundedJson(response));
  }
}
