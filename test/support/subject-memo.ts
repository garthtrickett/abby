import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AdministrativeMemoAuthentication, decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { administrativeMemoRecordBinding } from "../../src/cliniko/administrative-memo-records.ts";
import type { AdministrativeMemoConfig } from "../../src/cliniko/administrative-memo-records.ts";
import type { OutboundEffectBarrier } from "../../src/core/outbound-effect-barrier.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { ok } from "../../src/core/model.ts";
import type { ClinikoBookingMemoConfig, BookingMemoOutcome } from "../../src/standalone/cliniko-booking-memo.ts";

/** Synthetic native memo storage and independent clinic grants only.
 * The separate actual clinical owner must still supply its private receipt. */
export function subjectMemoFixture(native: AdministrativeMemoConfig, patientId: string, options: {
  approvedPatientId?: string; lostStored?: true;
  barrierFor?: (scope: LocationScope, binding: string) => OutboundEffectBarrier;
} = {}) {
  const service = new AbortController(), key = randomBytes(32), authentication = new AdministrativeMemoAuthentication(key);
  const posts: Record<string, unknown>[] = [], rows: Record<string, unknown>[] = [], consumed = new Set<string>();
  const outcomes: BookingMemoOutcome[] = [], control = { permitted: true };
  let settled!: () => void; const memoSettled = new Promise<void>(resolve => { settled = resolve; });
  const binding = administrativeMemoRecordBinding(native, authentication)!;
  const config: ClinikoBookingMemoConfig = {
    native, authentication, memoSignal: service.signal,
    authority: { allows: async () => control.permitted, current: () => control.permitted,
      producerAdmitted: async q => q.memo?.patientId === (options.approvedPatientId ?? patientId) },
    barrier: options.barrierFor?.(native.scope, binding) ?? {
      matches: (scope, owner) => JSON.stringify(scope) === JSON.stringify(native.scope) && owner === binding,
      claimOnce: async ref => { const claimed = !consumed.has(ref); consumed.add(ref); return ok({ claimed }); }
    },
    observeOutcome: value => { outcomes.push(value); settled(); },
    fetchPort: async (url, init) => {
      assert.equal(String(url), "https://api.au5.cliniko.com/v1/communications"); assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init.body)); posts.push(body);
      assert.equal(body.patient_id, patientId); assert.equal(body.confidential, true);
      const memo = resultMemo(body.content); assert.equal(memo.patientId, patientId); assert.equal(authentication.verify(memo), true);
      const now = memo.recordedAt;
      const row = { ...body, id: "701", created_at: now, updated_at: now, archived_at: null,
        patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${patientId}` } },
        links: { self: "https://api.au5.cliniko.com/v1/communications/701" } };
      rows.push(row); if (options.lostStored) throw Error("Synthetic memo acknowledgement lost after storage");
      return Response.json(row, { status: 201 });
    }
  };
  return { config, authentication, key, posts, rows, consumed, outcomes, control, memoSettled,
    close: () => service.abort() };
}

function resultMemo(content: unknown) {
  const decoded = decodeAdministrativeMemo(content); assert.ok(decoded.ok); return decoded.value;
}
