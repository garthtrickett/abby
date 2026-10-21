import assert from "node:assert/strict";
import { bookingMemoSessionFixture } from "./booking-memo-session.ts";
import { verificationCanaries } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { ClinikoBookingMemoRecovery } from "../../src/standalone/cliniko-booking-memo-recovery.ts";
import type { BookingMemoSourceQuery } from "../../src/standalone/cliniko-booking-memo-recovery.ts";

/** Actual admitted individual owner and receipt; transport/clinic grants are
 * synthetic. Fresh readers have no writer, private receipt or memo-ID cache. */
export async function bookingMemoRecoveryFixture(mode: "lostStored" | "lostUnstored" = "lostStored", deadlineMs = 500) {
  const rows: Record<string, unknown>[] = [];
  const f = await bookingMemoSessionFixture({ mode, clinicalFetchAround: port => async (url, init) => {
    const response = await port(url, init);
    if (new URL(String(url)).pathname === "/v1/individual_appointments" && init?.method === "POST") rows.push(await response.clone().json());
    return response;
  } });
  try {
    await f.prepare(); await f.drain(); assert.equal(rows.length, 1);
    const now = f.native.clock!(), row: Record<string, unknown> = { ...rows[0], created_at: now, updated_at: now,
      links: { self: `https://api.au5.cliniko.com/v1/individual_appointments/${rows[0]!.id}` } };
    const config = { ...f.native, deadlineMs }, calls: string[] = [], queries: BookingMemoSourceQuery[] = [];
    const gates = { read: true, decoded: true, sourceCurrent: true, collection: true, record: true, historyCurrent: true,
      hold: undefined as Promise<void> | undefined, before: undefined as ((path: string, count: number) => void) | undefined,
      sourceResponse: undefined as (() => Response) | undefined, afterGrant: undefined as ((q: BookingMemoSourceQuery) => void) | undefined };
    const port: typeof fetch = async (value, init) => {
      const url = new URL(String(value)), path = url.pathname; assert.equal(url.origin, "https://api.au5.cliniko.com");
      assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error"); calls.push(path); gates.before?.(path, calls.length);
      if (path.startsWith("/v1/individual_appointments/")) {
        assert.equal(path, `/v1/individual_appointments/${row.id}`);
        assert.deepEqual(url.searchParams.getAll("q[]"), ["archived_at:*", "cancelled_at:*", "deleted_at:*"]);
        return gates.sourceResponse?.() ?? Response.json(row);
      }
      assert.equal(path, "/v1/communications"); return Response.json({ communications: f.memoRows, total_entries: f.memoRows.length });
    };
    const fresh = () => resultValue(ClinikoBookingMemoRecovery.create(config, f.authentication,
      { allows: async q => { queries.push(q); gates.afterGrant?.(q); if (q.source) await gates.hold; return q.source ? gates.decoded : gates.read; },
        current: () => gates.sourceCurrent },
      { allowsHistoryRead: async () => gates.collection, allowsRecordRead: async () => gates.record, current: () => gates.historyCurrent }, port));
    const selection = { patientId: verificationCanaries[2]!, appointmentRef: `cliniko:appointment:${row.id}`,
      createdFrom: new Date(Date.parse(now) - 3600000).toISOString(), createdThrough: now };
    return { f, row, config, gates, calls, queries, port, fresh, selection };
  } catch (error) { await f.close(); throw error; }
}
