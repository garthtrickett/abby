import { validRecallDate } from "../recall-note.ts";
import { outboundNativeId, outboundNativeInstant } from "./outbound-record-context.ts";

type Row = Record<string, unknown>;
const object = (v: unknown): Row | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : undefined;
const self = (v: unknown) => object(object(v)?.links)?.self;
export type PatientRecallRow = Readonly<{ id: string; patientId: string; notes: string; recallAt: string; createdAt: string; updatedAt: string;
  recalled: boolean; recalledAt: string | null; archivedAt: string | null }>;
export type AccountRecallRow = PatientRecallRow & Readonly<{ typeId: string }>;
export class PatientRecallHistoryError extends Error {
  readonly kind = "malformed" as const;
  constructor() { super("Patient recall history unavailable"); }
}
/** Shared list decoding only. Caller owns independent collection grants,
 * request budget, response/body ownership and a whole-operation deadline.
 * No native IDs or timestamps choose an authoritative family-specific head. */
async function readRecallHistory(selection: Readonly<{ base: string; patientId?: string; typeIds: readonly string[] }>,
  load: (url: string) => Promise<unknown>, clock: () => string): Promise<Readonly<{ scanned: number; rows: readonly AccountRecallRow[] }>> {
  const { base, patientId, typeIds } = selection;
  const bad = () => { throw new PatientRecallHistoryError(); };
  if (!/^https:\/\/api\.[a-z]{2}[0-9]{1,2}\.cliniko\.com\/v1$/.test(base) || patientId !== undefined && !outboundNativeId(patientId) || !Array.isArray(typeIds) || typeIds.length < 1 || typeIds.length > 8 || !typeIds.every(outboundNativeId) || new Set(typeIds).size !== typeIds.length) bad();
  let total: number | undefined, scanned = 0, previous = 0n;
  const selected: AccountRecallRow[] = [];
  for (let page = 1; page <= 5; page++) {
    const query = new URLSearchParams({ page: String(page), per_page: "100", sort: "id:asc" });
    if (patientId !== undefined) query.append("q[]", `patient_id:=${patientId}`); query.append("q[]", "archived_at:*");
    const raw = await load(`${base}/recalls?${query}`), envelope = object(raw), count = envelope?.total_entries, rows = envelope?.recalls;
    if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 500 || !Array.isArray(rows) || total !== undefined && count !== total) bad();
    total = count as number;
    if (!Array.isArray(rows) || rows.length !== Math.min(100, total - scanned)) bad();
    const observedAt = clock();
    for (const value of rows as unknown[]) {
      const row = object(value), id = row?.id, createdAt = outboundNativeInstant(row?.created_at), updatedAt = outboundNativeInstant(row?.updated_at);
      const patientLink = self(row?.patient), typeLink = self(row?.recall_type);
      const rowPatient = typeof patientLink === "string" && patientLink.startsWith(`${base}/patients/`) ? patientLink.slice(`${base}/patients/`.length) : undefined;
      const rowType = typeof typeLink === "string" && typeLink.startsWith(`${base}/recall_types/`) ? typeLink.slice(`${base}/recall_types/`.length) : undefined;
      if (!row || !outboundNativeId(id) || BigInt(id) <= previous || self(row) !== `${base}/recalls/${id}` || !outboundNativeId(rowPatient) || !outboundNativeId(rowType) ||
        !createdAt || !updatedAt || createdAt > updatedAt || Date.parse(updatedAt) > Date.parse(observedAt) + 30000 || patientId !== undefined && rowPatient !== patientId || typeof row.recalled !== "boolean" ||
        row.archived_at !== null && !outboundNativeInstant(row.archived_at) || row.recalled_at !== null && !outboundNativeInstant(row.recalled_at) ||
        row.recalled !== (row.recalled_at !== null) || row.archived_at !== null && Date.parse(String(row.archived_at)) > Date.parse(updatedAt) ||
        row.recalled_at !== null && Date.parse(String(row.recalled_at)) > Date.parse(updatedAt) || !validRecallDate(row.recall_at)) bad();
      const valid = row!; previous = BigInt(id as string); scanned++;
      if (!typeIds.includes(rowType as string)) continue;
      if (typeof valid.notes !== "string" || valid.notes.length > 1050 || selected.length >= 50) bad();
      selected.push(Object.freeze({ id: id as string, patientId: rowPatient as string, typeId: rowType as string, notes: valid.notes as string, recallAt: valid.recall_at as string, createdAt: createdAt!, updatedAt: updatedAt!,
        recalled: valid.recalled as boolean, recalledAt: valid.recalled_at === null ? null : outboundNativeInstant(valid.recalled_at)!,
        archivedAt: valid.archived_at === null ? null : outboundNativeInstant(valid.archived_at)! }));
    }
    if (scanned === total) break;
    if (page === 5) bad();
  }
  return Object.freeze({ scanned, rows: Object.freeze(selected) });
}

/** Preserve the existing patient-scoped row shape and documented patient filter. */
export async function readPatientRecallHistory(selection: Readonly<{ base: string; patientId: string; typeId: string }>,
  load: (url: string) => Promise<unknown>, clock: () => string): Promise<Readonly<{ scanned: number; rows: readonly PatientRecallRow[] }>> {
  if (!outboundNativeId(selection.patientId) || !outboundNativeId(selection.typeId)) throw new PatientRecallHistoryError();
  const found = await readRecallHistory({ base: selection.base, patientId: selection.patientId, typeIds: [selection.typeId] }, load, clock);
  return Object.freeze({ scanned: found.scanned, rows: Object.freeze(found.rows.map(({ typeId: _typeId, ...r }) => Object.freeze(r))) });
}
/** A verified-patient consumer may correlate several explicitly approved record
 * families without broadening to an account read or multiplying the bounds. */
export async function readPatientRecallFamilies(selection: Readonly<{ base: string; patientId: string; typeIds: readonly string[] }>,
  load: (url: string) => Promise<unknown>, clock: () => string): Promise<Readonly<{ scanned: number; rows: readonly AccountRecallRow[] }>> {
  if (!selection || Object.keys(selection).sort().join(",") !== "base,patientId,typeIds" || !outboundNativeId(selection.patientId))
    throw new PatientRecallHistoryError();
  return readRecallHistory(selection, load, clock);
}
/** Broad account-body visibility must be independently approved by the caller.
 * There is no documented native type/phone filter. Historical closed/archived
 * rows stay visible; the unchanged500-row/50-selected bounds apply in aggregate. */
export async function readAccountRecallHistory(selection: Readonly<{ base: string; typeIds: readonly string[] }>,
  load: (url: string) => Promise<unknown>, clock: () => string): Promise<Readonly<{ scanned: number; rows: readonly AccountRecallRow[] }>> {
  if (!selection || Object.keys(selection).sort().join(",") !== "base,typeIds" || !Array.isArray(selection.typeIds)) throw new PatientRecallHistoryError();
  return readRecallHistory({ base: selection.base, typeIds: Object.freeze([...selection.typeIds]) }, load, clock);
}
