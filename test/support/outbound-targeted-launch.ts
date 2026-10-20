import assert from "node:assert/strict";
import { outboundLaunchOwnerFixture } from "./outbound-launch-owner.ts";
import { outboundTargetFixture } from "./outbound-appointment-target.ts";
import { value } from "./outbound-records.ts";
import { ClinikoOutboundAppointmentTarget } from "../../src/cliniko/outbound-appointment-target.ts";
import { ClinikoOutboundLaunchOwner } from "../../src/standalone/cliniko-outbound-launch-owner.ts";
import { encodeOutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
import type { OutboundTargetAuthority, OutboundTargetQuery } from "../../src/cliniko/outbound-appointment-target.ts";
import type { OutboundLaunchQuery } from "../../src/standalone/cliniko-outbound-launch-owner.ts";

export async function outboundTargetedLaunchFixture(options: Parameters<typeof outboundLaunchOwnerFixture>[0] = {}) {
  const f = await outboundLaunchOwnerFixture({ ...options, purpose: "sickDay", appointment: { ref: "cliniko:appointment:71", digest: "a".repeat(64) } });
  try {
    const row: Record<string, unknown> = { ...outboundTargetFixture().row, patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${f.request.patientId}` } },
      business: { links: { self: `https://api.au5.cliniko.com/v1/businesses/${f.request.businessId}` } },
      starts_at: "2026-11-03T10:00:00.000001+11:00", ends_at: "2026-11-03T10:30:00.000001+11:00" };
    const state: { live: boolean; allowed: boolean; gets: number; beforeRead?: () => void | Promise<void>;
      allows?: (q: OutboundTargetQuery) => boolean | Promise<boolean>;
      launchAllows?: (q: OutboundLaunchQuery) => boolean | Promise<boolean> } = { live: true, allowed: true, gets: 0 };
    const queries: OutboundTargetQuery[] = [], launchQueries: OutboundLaunchQuery[] = [];
    const authority: OutboundTargetAuthority = { allows: async q => { queries.push(q); return state.allowed && (state.allows ? await state.allows(q) : true); }, current: () => state.live };
    const native: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname.startsWith("/v1/individual_appointments")) {
        assert.equal(String(url), "https://api.au5.cliniko.com/v1/individual_appointments/71"); assert.ok(init); assert.equal(init.method, "GET"); assert.equal(init.redirect, "error");
        state.gets++; await state.beforeRead?.(); return Response.json(row);
      }
      return f.native(url, init);
    };
    const targetConfig = { requests: f.config.requests, appointmentPolicyDigest: "9".repeat(64) };
    const observed = value(await value(ClinikoOutboundAppointmentTarget.create(targetConfig, authority, native)).observeTarget({
      patientId: f.request.patientId, appointmentRef: "cliniko:appointment:71" }, new AbortController().signal));
    Object.assign(f.request, { appointment: { ref: observed.target.appointmentRef, digest: observed.digest } });
    f.requestRow.notes = value(encodeOutboundRecipientRequest(f.request));
    const config = { ...f.config, individualTarget: { appointmentPolicyDigest: targetConfig.appointmentPolicyDigest } };
    const ports = { ...f.ports, native, target: authority, authority: { current: f.ports.authority.current,
      allows: async (q: OutboundLaunchQuery, signal: AbortSignal) => { launchQueries.push(q); return await f.ports.authority.allows(q, signal) && (state.launchAllows ? await state.launchAllows(q) : true); } } };
    const Owner = options.runtime?.ClinikoOutboundLaunchOwner ?? ClinikoOutboundLaunchOwner;
    const makeTargeted = () => Owner.create(config, ports), owner = value(makeTargeted());
    state.gets = 0; queries.length = 0;
    return { ...f, get claims() { return f.claims; }, get posts() { return f.posts; }, targetRow: row, targetState: state, targetQueries: queries, targetLaunchQueries: launchQueries, targetConfig: config, targetPorts: ports,
      observed, makeTargeted, targeted: owner, launchTargeted: (signal = new AbortController().signal) => owner.launchOnce(f.binding, signal) };
  } catch (error) { await f.close(); throw error; }
}
