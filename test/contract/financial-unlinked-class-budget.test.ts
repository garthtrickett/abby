import assert from 'node:assert/strict';
import test from 'node:test';
import { unlinkedClassExpiryFixture } from '../support/financial-unlinked-class-expiry.ts';
import { classAttendee, classLink } from '../support/class-attendance.ts';
import { ClinikoReadBudget } from '../../src/cliniko/read-budget.ts';
import { financialRecordOwnerBinding } from '../../src/cliniko/financial-record-retention.ts';
test('the complete maximum native unlinked class expiry fits the shared physical180 account budget', { timeout: 10_000 }, async () => {
let clock = Date.parse('2026-11-01T10:00:00.000Z'), claims = 0; let atCancel: number | undefined;
const budget = new ClinikoReadBudget(180, () => clock), burned = new Set<string>();
let f!: Awaited<ReturnType<typeof unlinkedClassExpiryFixture>>;
f = await unlinkedClassExpiryFixture({ barrierFor(config) {
  Object.assign(config.rateBudget, { claim: () => { claims++; return budget.claim(); }, observe429: budget.observe429.bind(budget), checkHeadroom: budget.checkHeadroom.bind(budget) });
  const owner = financialRecordOwnerBinding(config); assert.ok(owner.ok); const ownerBinding = owner.value;
  return { matches: (scope, binding) => JSON.stringify(scope) === JSON.stringify(config.scope) && binding === ownerBinding,
    claimOnce: async ref => { const claimed = !burned.has(ref); burned.add(ref); return { ok: true, value: { claimed } }; } };
}, beforeCancel() { assert.ok(burned.has(f.intent.effects.clinicalExpiry)); atCancel = claims; } });
try {
  clock = Date.parse(f.config.cliniko.clock!()); claims = 0;
  for (let i = 0; i < 499; i++) f.attendance.attendees.push({ ...classAttendee(String(1000+i), '91', String(10000+i), '2026-11-01T10:00:00.000Z'), arrived: null });
  f.attendance.onResponse((path, body) => {
    const resource = path === '/v1/practitioners/22/businesses' ? 'businesses' : path === '/v1/practitioners/22/appointment_types' ? 'appointment_types' : undefined;
    if (!resource) return;
    const page = f.attendance.traffic.at(-1)!.page;
    const entries = Array.from({length:500}, (_,i) => { const id = i === 0 ? resource === 'businesses' ? '11' : '33' : String(1000+i); return { id, ...classLink(resource,id) }; });
    body[resource] = entries.slice((page-1)*100,page*100); body.total_entries = entries.length;
  });
  const result = await f.expireClass();
  assert.ok(atCancel !== undefined && atCancel <= 180);
  assert.ok(claims <= 180); assert.equal(f.cancellations.length, 1);
  assert.equal(f.attendance.attendees.length, 500);
  assert.ok(result.ok && result.value.kind === 'cancelled', 'complete maximum supported native plan fits the physical180 budget');
} finally { await f.close(); }

});
