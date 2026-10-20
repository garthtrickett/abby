import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { outboundLaunchOwnerFixture } from "./outbound-launch-owner.ts";
import { value } from "./outbound-records.ts";
import { OwnerFileOutboundContactAccount } from "../../src/standalone/owner-file-outbound-contact-account.ts";
import { ClinikoOutboundLaunchOwner } from "../../src/standalone/cliniko-outbound-launch-owner.ts";
import { contactSourceSelection } from "../../src/cliniko/outbound-contact-source.ts";
import { outboundContactGuardOwnerBinding } from "../../src/core/outbound-capacity.ts";
import type { OutboundCapacity } from "../../src/core/outbound-capacity.ts";
import { decodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import type { OutboundNumberStopQuery } from "../../src/standalone/cliniko-outbound-number-stops.ts";

type BaseOptions = NonNullable<Parameters<typeof outboundLaunchOwnerFixture>[0]>;
export async function outboundContactLifecycleFixture(options: Omit<BaseOptions, "runtime"> & { guardRef?: string; capacity?: OutboundCapacity;
  runtime?: NonNullable<BaseOptions["runtime"]> & { OwnerFileOutboundContactAccount?: typeof OwnerFileOutboundContactAccount }; } = {}) {
  const f = await outboundLaunchOwnerFixture(options);
  try {
    const guardRef = options.guardRef ?? randomUUID(), path = join(dirname(f.definitionConfig.path), "guarded-account.json"), source = contactSourceSelection(f.config.contact);
    const { source: _source, ...common } = f.approval;
    const approval = { ...common, revision: "guarded-contact-1", account: { ref: "complete-native-account", contactGuardRef: guardRef,
      coverage: "allCurrentAndRetiredVoiceContactSources", credentialFingerprints: [f.request.credentialFingerprint], sources: [source] } };
    await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
    const captureConfig = { path, scope: f.request.scope, credentialFingerprint: f.request.credentialFingerprint, directory: f.directory,
      definitions: [{ selection: source, definition: f.definition }], clock: () => f.state.now };
    const account = value(await (options.runtime?.OwnerFileOutboundContactAccount ?? OwnerFileOutboundContactAccount).capture(captureConfig, new AbortController().signal));
    const held = new Set<string>(), used = new Set<string>(), released = new Set<string>(), ownerBinding = outboundContactGuardOwnerBinding(guardRef)!;
    const memory: OutboundCapacity = { matches: (scope, owner) => JSON.stringify(scope) === JSON.stringify(f.request.scope) && owner === ownerBinding,
      acquireOnce: async (ref, maximum) => {
        if (used.has(ref)) return { ok: true, value: { kind: "alreadyUsed" } };
        if (held.size >= maximum) return { ok: true, value: { kind: "full" } };
        used.add(ref); held.add(ref); return { ok: true, value: { kind: "acquired" } };
      }, releaseOnce: async (ref, current) => { if (current && current() !== true) return { ok: false, error: { kind: "forbidden" } };
        const changed = held.delete(ref); if (changed) released.add(ref); return { ok: true, value: { released: changed } }; } };
    const capacity = options.capacity ?? memory;
    const state: { live: boolean; allow?: (q: OutboundNumberStopQuery) => boolean | Promise<boolean>; broadReads: number } = { live: true, broadReads: 0 };
    const queries: OutboundNumberStopQuery[] = [], numberStops = { allows: async (q: OutboundNumberStopQuery) => { queries.push(q); return state.allow ? state.allow(q) : true; }, current: () => state.live };
    const native: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/recalls" && init?.method === "GET") {
        assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init.redirect, "error"); assert.equal(init.body, undefined);
        assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from(`${f.config.requests.apiKey}:`).toString("base64")}`);
        const filters = url.searchParams.getAll("q[]"), broad = filters.join(",") === "archived_at:*";
        assert.deepEqual(filters, broad ? ["archived_at:*"] : [`patient_id:=${f.request.patientId}`, "archived_at:*"]);
        if (broad) state.broadReads++;
        const page = Number(url.searchParams.get("page")), rows = [...f.contactControls.rows].filter(row => broad ||
          (row.patient as { links: { self: string } }).links.self === `https://api.au5.cliniko.com/v1/patients/${f.request.patientId}`).sort((a, b) => Number(a.id) - Number(b.id));
        return Response.json({ recalls: rows.slice((page - 1) * 100, page * 100), total_entries: rows.length });
      }
      return f.native(input, init);
    };
    const config = { ...f.config, maximumNativeRequests: 180, contactSafety: { guardRef, account, maximumNativeRequests: 20 } };
    const ports = { ...f.ports, native, numberStops, contactCapacity: capacity };
    const make = () => (options.runtime?.ClinikoOutboundLaunchOwner ?? ClinikoOutboundLaunchOwner).create(config, ports), owner = value(make());
    const retained = () => { const row = f.contactControls.rows.find(r => String((r.recall_type as { links: { self: string } }).links.self).endsWith("/62"));
      assert.ok(row); return { row, attempt: value(decodeOutboundLaunchAttempt(row.notes)) }; };
    return { ...f, config, ports, owner, make, guardRef, capacity, contactHeld: held, contactReleased: released, contactUsed: used, safetyState: state, numberQueries: queries,
      account, accountApproval: approval, captureConfig, native, retained,
      get posts() { return f.posts; }, get claims() { return f.claims; },
      launch: (signal = new AbortController().signal) => owner.launchOnce(f.binding, signal),
      replaceAccount: (patch: Record<string, unknown>) => writeFile(path, JSON.stringify({ ...approval, ...patch }), { mode: 0o600 }) };
  } catch (e) { await f.close(); throw e; }
}
