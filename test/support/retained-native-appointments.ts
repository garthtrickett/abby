/** Volatile native provider state after the original admitted caller ends.
 * Rows are the same acknowledged objects; no replacement target is seeded.
 * Financial permission and consent remain with the production expiry owner. */
import assert from "node:assert/strict";

export function retainedNativeAppointments(rows: ReadonlyMap<string, Record<string, unknown>>, clock: () => string,
  fallback: typeof fetch): Readonly<{ fetchPort: typeof fetch; cancellations: readonly unknown[] }> {
  const cancellations: Record<string, unknown>[] = [];
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    const match = /^\/v1\/individual_appointments\/([1-9][0-9]*)(?:\/(conflicts|cancel))?$/.exec(url.pathname);
    if (!match) return fallback(input, init);
    const row = rows.get(match[1]!);
    if (!row) return new Response(null, { status: 404 });
    if (method === "GET" && match[2] !== "cancel")
      return Response.json(match[2] === "conflicts" ? { conflicts: { exist: false } } : row);
    assert.equal(method, "PATCH"); assert.equal(match[2], "cancel");
    assert.equal(row.cancelled_at, null, "the original native appointment can be cancelled only once");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { cancellation_note: null, cancellation_reason: 50, apply_to_repeats: false });
    cancellations.push(body); Object.assign(row, { cancelled_at: clock(), cancellation_reason: 50 });
    return new Response(null, { status: 204 });
  };
  return { fetchPort, cancellations };
}
