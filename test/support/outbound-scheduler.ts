import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { outboundLaunchOwnerFixture } from "./outbound-launch-owner.ts";
import { outboundTargetedLaunchFixture } from "./outbound-targeted-launch.ts";
import { value } from "./outbound-records.ts";
import { encodeOutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
import { ClinikoOutboundScheduler } from "../../src/standalone/cliniko-outbound-scheduler.ts";

export async function outboundSchedulerFixture(options: NonNullable<Parameters<typeof outboundLaunchOwnerFixture>[0]> & {
  Scheduler?: typeof ClinikoOutboundScheduler; tickDeadlineMs?: number; exactSickDay?: boolean } = {}) {
  const { Scheduler = ClinikoOutboundScheduler, tickDeadlineMs = 120_000, exactSickDay = false, ...launchOptions } = options;
  const targetedLaunch = exactSickDay ? await outboundTargetedLaunchFixture(launchOptions) : undefined;
  const f = targetedLaunch ?? await outboundLaunchOwnerFixture(launchOptions);
  try {
    const launchConfig = targetedLaunch?.targetConfig ?? f.config, launchPorts = targetedLaunch?.targetPorts ?? f.ports;
    const state: { schedule: boolean; pending: boolean; record: boolean; waits: number; accountReads: number;
      beforeWait?: (ms: number, signal: AbortSignal) => void | Promise<void>;
      onAccount?: () => void | Promise<void> } = { schedule: true, pending: true, record: true, waits: 0, accountReads: 0 };
    const native: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method !== "POST" && url.pathname === "/v1/recalls" && url.searchParams.getAll("q[]").includes("recalled_at:!?")) {
        state.accountReads++; await state.onAccount?.();
        assert.deepEqual(url.searchParams.getAll("q[]"), ["recalled_at:!?", "archived_at:!?"]);
        const rows = f.contactControls.rows.filter(r => r.recalled === false && r.recalled_at === null && r.archived_at === null)
          .sort((a, b) => Number(a.id) - Number(b.id));
        const page = Number(url.searchParams.get("page"));
        return Response.json({ total_entries: rows.length, recalls: rows.slice((page - 1) * 100, page * 100) });
      }
      if (init?.method !== "POST" && url.pathname.startsWith("/v1/patients/")) {
        const patientId = url.pathname.split("/").at(-1)!;
        return Response.json({ ...f.contactControls.patient, id: patientId,
          links: { self: `https://api.au5.cliniko.com/v1/patients/${patientId}` } });
      }
      if (init?.method !== "POST" && url.pathname === "/v1/recalls") {
        const patient = url.searchParams.getAll("q[]").find(q => q.startsWith("patient_id:="))?.slice(12);
        assert.ok(patient);
        const rows = f.contactControls.rows.filter(r =>
          (r.patient as { links: { self: string } }).links.self === `https://api.au5.cliniko.com/v1/patients/${patient}`)
          .sort((a, b) => Number(a.id) - Number(b.id));
        const page = Number(url.searchParams.get("page"));
        return Response.json({ total_entries: rows.length, recalls: rows.slice((page - 1) * 100, page * 100) });
      }
      return (launchPorts.native ?? f.native)(input, init);
    };
    const config = { launch: launchConfig, maximumScanNativeRequests: 55, tickDeadlineMs };
    const ports = { launch: { ...launchPorts, native }, pending: { allowsPendingRead: async () => state.pending,
      allowsRecordRead: async () => state.record, current: () => state.pending && state.record },
      schedule: { allows: async () => state.schedule, current: () => state.schedule },
      waitForQuota: async (ms: number, signal: AbortSignal) => {
        state.waits++; await state.beforeWait?.(ms, signal);
        if (!signal.aborted) f.state.now = new Date(Date.parse(f.state.now) + ms).toISOString();
      } };
    const make = () => value(Scheduler.create(config, ports)), scheduler = make();
    const addRequest = (patientId = f.request.patientId) => {
      const request = { ...f.request, patientId, actionRef: randomUUID(), approvalRef: randomUUID(), effectRef: randomUUID() };
      const id = String(31 + f.contactControls.rows.filter(r => (r.recall_type as { links: { self: string } }).links.self.endsWith("/61")).length);
      if (patientId !== f.request.patientId) {
        const review = { ...f.first, patientId, actionRef: randomUUID(), approvalRef: randomUUID() };
        f.contactControls.rows.push({ ...f.row(review, "102"), patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${patientId}` } } });
      }
      f.contactControls.rows.push({ ...f.requestRow, id, patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${patientId}` } }, links: { self: `https://api.au5.cliniko.com/v1/recalls/${id}` },
        notes: value(encodeOutboundRecipientRequest(request)) });
      return request;
    };
    return { ...f, targetedLaunch, get claims() { return f.claims; }, get posts() { return f.posts; }, scheduleState: state,
      schedulerConfig: config, schedulerPorts: ports, scheduler, makeScheduler: make, addRequest,
      tick: (signal = new AbortController().signal) => scheduler.tick(signal) };
  } catch (error) { await f.close(); throw error; }
}
