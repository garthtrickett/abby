import { isDeepStrictEqual } from "node:util";
import { clinikoCredentialFingerprint } from "../read-budget.ts";
import { readNativeOutboundPatientHistory } from "./outbound-account-history.ts";
import type { AccountRecallRow } from "./patient-recall-history.ts";

type Selection = Parameters<typeof readNativeOutboundPatientHistory>[0];
type Control = Parameters<typeof readNativeOutboundPatientHistory>[1];
const snapshotOwner = Symbol("patient recall snapshot owner");

/** One actually fetched, bounded, separately approved native patient history.
 * This is neither an arbitrary row DTO nor a cache between operations. Private
 * fields keep the body out of accidental JSON serialization. Family readers
 * still require their own selection/body grants and their existing codecs. */
export class PatientRecallSnapshot {
  readonly #base: string;
  readonly #credential: string;
  readonly #patientId: string;
  readonly #typeIds: readonly string[];
  readonly #rows: readonly AccountRecallRow[];
  readonly #scanned: number;
  readonly #signal: AbortSignal;
  readonly #current: Control["current"];
  private constructor(owner: typeof snapshotOwner, selection: Selection, control: Control, history: Awaited<ReturnType<typeof readNativeOutboundPatientHistory>>) {
    if (owner !== snapshotOwner) throw Error("Native patient history unavailable");
    this.#base = selection.base; this.#credential = clinikoCredentialFingerprint(selection.apiKey); this.#patientId = selection.patientId;
    this.#typeIds = Object.freeze([...selection.typeIds]); this.#rows = history.rows; this.#scanned = history.scanned;
    this.#signal = control.signal; this.#current = control.current.bind(control); Object.freeze(this);
  }
  static async read(selection: Selection, control: Control, port: typeof fetch): Promise<PatientRecallSnapshot> {
    if (!(control.signal instanceof AbortSignal) || control.signal.aborted) throw Error("Native patient history unavailable");
    const selected = Object.freeze({ ...selection, typeIds: Object.freeze([...selection.typeIds]) });
    const captured = Object.freeze({ signal: control.signal, now: control.now.bind(control), current: control.current.bind(control),
      permit: control.permit.bind(control), wait: control.wait.bind(control) });
    const history = await readNativeOutboundPatientHistory(selected, captured, port);
    captured.current(); if (captured.signal.aborted) throw Error("Native patient history unavailable");
    return new PatientRecallSnapshot(snapshotOwner, selected, captured, history);
  }
  #live(signal: AbortSignal): void {
    if (signal !== this.#signal || signal.aborted) throw Error("Native patient history unavailable");
    this.#current(); if (signal.aborted) throw Error("Native patient history unavailable");
  }
  get rows(): readonly AccountRecallRow[] { this.#live(this.#signal); return this.#rows; }
  get scanned(): number { this.#live(this.#signal); return this.#scanned; }
  sameVersion(other: PatientRecallSnapshot): boolean {
    if (!(other instanceof PatientRecallSnapshot)) return false;
    this.#live(this.#signal); other.#live(this.#signal);
    return this.#base === other.#base && this.#credential === other.#credential && this.#patientId === other.#patientId &&
      isDeepStrictEqual(this.#typeIds, other.#typeIds) && this.#scanned === other.#scanned && isDeepStrictEqual(this.#rows, other.#rows);
  }
  nativeRow(base: string, credential: string, patientId: string, typeId: string, recallRef: string, signal: AbortSignal): unknown {
    this.#live(signal);
    if (base !== this.#base || credential !== this.#credential || patientId !== this.#patientId || !this.#typeIds.includes(typeId)) return undefined;
    const row = this.#rows.find(r => `cliniko:recall:${r.id}` === recallRef && r.typeId === typeId && r.patientId === patientId);
    if (!row) return undefined;
    return { id: row.id, links: { self: `${base}/recalls/${row.id}` }, patient: { links: { self: `${base}/patients/${row.patientId}` } },
      recall_type: { links: { self: `${base}/recall_types/${row.typeId}` } }, notes: row.notes, recall_at: row.recallAt,
      created_at: row.createdAt, updated_at: row.updatedAt, recalled: row.recalled, recalled_at: row.recalledAt, archived_at: row.archivedAt };
  }
}
