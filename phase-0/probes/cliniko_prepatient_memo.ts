import { randomUUID } from "node:crypto";
import { boundedClinikoJson } from "../../src/cliniko/bounded-json.ts";
import { ClinikoReadBudget, claimClinikoBudget, observeCliniko429 } from "../../src/cliniko/read-budget.ts";
import { err, ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { normalizeEmailAddress } from "../../src/shared/email-address.ts";

type Row = Record<string, unknown>;
const object = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const id = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
const sender = "Abby pre-patient memo research";
const recipient = "Abby synthetic research only";
const prefix = "Abby pre-patient memo probe v1; no patient or appointment creation; ";
const contentPattern = /^Abby pre-patient memo probe v1; no patient or appointment creation; [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type MemoProbeFailure = Readonly<{ kind: "invalidConfig" | "unavailable" | "uncertainCreate" | "unsafeCleanup" }>;
export type MemoProbeResult = Readonly<{
  kind: "rejected" | "memoAccepted" | "status" | "cleaned";
  rejectedPatientField: boolean;
  activeProbeMemos: number;
  patientlessProbeMemos: number;
  patientOrAppointmentWrites: 0;
}>;
class ProbeFailure extends Error {
  readonly kind: MemoProbeFailure["kind"];
  constructor(kind: MemoProbeFailure["kind"]) { super(kind); this.kind = kind; }
}

/** Demo research only. No patient draft, staff workflow or caller permission is accepted. */
export class ClinikoPrepatientMemoProbe {
  readonly #base: string;
  readonly #key: string;
  readonly #contact: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #budget = new ClinikoReadBudget(30);
  constructor(config: Readonly<{ apiKey: string; contactEmail: string; timeoutMs?: number }>, fetchPort: typeof fetch = fetch) {
    const shard = typeof config?.apiKey === "string" ? config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1] : undefined;
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || /[\u0000-\u001f\u007f]/.test(config.apiKey) ||
        !normalizeEmailAddress(config.contactEmail) || typeof fetchPort !== "function" ||
        (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 30_000))) {
      throw new ProbeFailure("invalidConfig");
    }
    this.#base = `https://api.${shard}.cliniko.com/v1`;
    this.#key = config.apiKey; this.#contact = config.contactEmail; this.#fetch = fetchPort; this.#timeoutMs = config.timeoutMs ?? 15_000;
  }
  async #request(method: "GET" | "POST", path: string, body?: Row): Promise<{ status: number; body?: unknown }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = (async () => {
        if (await claimClinikoBudget(this.#budget) || controller.signal.aborted) throw new ProbeFailure("unavailable");
        const response = await this.#fetch(this.#base + path, { method, redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", "Content-Type": "application/json",
            Authorization: `Basic ${Buffer.from(`${this.#key}:`).toString("base64")}`,
            "User-Agent": `Abby demo pre-patient research (${this.#contact})` },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        if (response.status === 429) await observeCliniko429(this.#budget, response.headers.get("X-RateLimit-Reset"));
        if (response.status === 204) return { status: 204 };
        const parsed = await boundedClinikoJson(response);
        if (!parsed.ok) throw new ProbeFailure(method === "POST" ? "uncertainCreate" : "unavailable");
        return { status: response.status, body: parsed.value };
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ProbeFailure(method === "POST" ? "uncertainCreate" : "unavailable")); }, this.#timeoutMs);
      });
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (error instanceof ProbeFailure) throw error;
      throw new ProbeFailure(method === "POST" ? "uncertainCreate" : "unavailable");
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  #owned(row: Row): boolean {
    return id(row.id) && row.category_code === 12 && row.type_code === 4 && row.direction_code === 2 &&
      row.confidential === false && row.from === sender && row.to === recipient &&
      typeof row.content === "string" && contentPattern.test(row.content);
  }
  async #discover(): Promise<Row[]> {
    const owned: Row[] = []; let expected: number | undefined, seen = 0, previous = 0n;
    for (let page = 1; page <= 5; page++) {
      const response = await this.#request("GET", `/communications?per_page=100&page=${page}&sort=id:asc&q%5B%5D=category_code%3A%3D12`);
      const body = object(response.body), rows = body?.communications, total = body?.total_entries;
      if (response.status !== 200 || !Array.isArray(rows) || !Number.isSafeInteger(total) || Number(total) < 0 || Number(total) > 500 ||
          (expected !== undefined && expected !== total) || rows.length !== Math.min(100, Math.max(0, Number(total) - seen))) {
        throw new ProbeFailure("unavailable");
      }
      expected = Number(total);
      for (const value of rows) {
        const row = object(value);
        if (!row || !id(row.id) || BigInt(row.id) <= previous || row.archived_at !== null || row.category_code !== 12) {
          throw new ProbeFailure("unavailable");
        }
        previous = BigInt(row.id); seen++;
        if (row.from === sender || (typeof row.content === "string" && row.content.startsWith(prefix))) {
          if (!this.#owned(row)) throw new ProbeFailure("unsafeCleanup");
          owned.push(row);
        }
      }
      if (seen === expected) return owned;
    }
    throw new ProbeFailure("unavailable");
  }
  #summary(kind: MemoProbeResult["kind"], rows: Row[], rejectedPatientField = false): MemoProbeResult {
    return { kind, rejectedPatientField, activeProbeMemos: rows.length,
      patientlessProbeMemos: rows.filter(row => row.patient === null || row.patient === undefined).length,
      patientOrAppointmentWrites: 0 };
  }
  async run(mode: "omit" | "null" | "status" | "cleanup"): Promise<Result<MemoProbeResult, MemoProbeFailure>> {
    try {
      if (!["omit", "null", "status", "cleanup"].includes(mode)) return err({ kind: "invalidConfig" });
      const before = await this.#discover();
      if (mode === "status" || ((mode === "omit" || mode === "null") && before.length)) return ok(this.#summary("status", before));
      if (mode === "cleanup") {
        for (const saved of before) {
          const current = await this.#request("GET", `/communications/${saved.id}`), row = object(current.body);
          if (current.status !== 200 || !row || !this.#owned(row) || row.archived_at !== null ||
              row.id !== saved.id || row.content !== saved.content || row.updated_at !== saved.updated_at ||
              JSON.stringify(row.patient) !== JSON.stringify(saved.patient)) throw new ProbeFailure("unsafeCleanup");
          const archived = await this.#request("POST", `/communications/${saved.id}/archive`);
          const checked = await this.#request("GET", `/communications/${saved.id}?q%5B%5D=archived_at%3A*`);
          const after = object(checked.body);
          if (archived.status !== 204 || checked.status !== 200 || !after || !this.#owned(after) || after.id !== saved.id ||
              typeof after.archived_at !== "string" || !Number.isFinite(Date.parse(after.archived_at))) throw new ProbeFailure("unsafeCleanup");
        }
        const remaining = await this.#discover();
        if (remaining.length) throw new ProbeFailure("unsafeCleanup");
        return ok(this.#summary("cleaned", remaining));
      }
      const content = prefix + randomUUID();
      const created = await this.#request("POST", "/communications", { category_code: 12, confidential: false,
        direction_code: 2, from: sender, to: recipient, type_code: 4, content, ...(mode === "null" ? { patient_id: null } : {}) });
      if (created.status === 422) {
        const errors = object(object(created.body)?.errors);
        const rejectedPatientField = !!errors && (Object.hasOwn(errors, "patient") || Object.hasOwn(errors, "patient_id"));
        const after = await this.#discover();
        if (after.length) throw new ProbeFailure("uncertainCreate");
        return ok(this.#summary("rejected", after, rejectedPatientField));
      }
      const row = object(created.body);
      if (created.status !== 201 || !row || !this.#owned(row) || row.content !== content || row.archived_at !== null) {
        throw new ProbeFailure("uncertainCreate");
      }
      const after = await this.#discover();
      if (after.length !== 1 || after[0]?.id !== row.id || after[0]?.content !== content) throw new ProbeFailure("uncertainCreate");
      return ok(this.#summary("memoAccepted", after));
    } catch (error) { return err({ kind: error instanceof ProbeFailure ? error.kind : "unavailable" }); }
  }
}
