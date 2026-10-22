/** Crash witness: real emitted HTTP/native/SQL owners in a fresh process.
 * IPC supplies synthetic remote services and grants held current during the
 * crash. Revocation is qualified separately; no lost local call handles enter. */
import { createServer } from 'node:http';
import { once } from 'node:events';
const emitted = new URL('../../dist/runtime/src/', import.meta.url);
const load = path => import(new URL(path, emitted));
const { connectPostgres } = await load('storage/connect.js');
const { PostgresClinikoRequestBudget } = await load('storage/postgres-cliniko-request-budget.js');
const { PostgresOutboundEffectBarrier } = await load('storage/postgres-outbound-effect-barrier.js');
const { TwilioAbbyOutboundRuntime } = await load('voice/twilio-outbound-runtime.js');
const { TwilioOutboundReportAuthentication } = await load('cliniko/twilio-outbound-report.js');
const { OwnerFileOutboundDncPolicy } = await load('standalone/owner-file-outbound-dnc-policy.js');
const { outboundDncRecordBinding } = await load('cliniko/outbound-dnc-records.js');
const { outboundStaffReviewRecordBinding } = await load('cliniko/outbound-staff-review-records.js');
const { TwilioOutboundTerminalObservationAuthentication } = await load('cliniko/twilio-outbound-terminal-observation.js');
const { clinikoCredentialFingerprint } = await load('cliniko/read-budget.js');
const { TwilioOutboundStatusDelivery } = await load('standalone/twilio-outbound-status-delivery.js');
const { twilioOutboundStatusReceiver } = await load('standalone/twilio-outbound-status-receiver.js');
let next = 0, started = false, db, server, receiver;
const pending = new Map();
const rpc = (kind, data) => new Promise(resolve => {
  const id = ++next; pending.set(id, resolve); process.send?.({ kind, id, data });
});
const close = async () => {
  receiver?.close(); server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await db?.destroy(); process.disconnect?.();
};
process.on('message', async message => {
  if (message?.kind === 'reply') { pending.get(message.id)?.(message.data); pending.delete(message.id); return; }
  if (message?.kind === 'close') { await close(); return; }
  if (message?.kind !== 'start' || started) return;
  started = true;
  try {
    const s = message.data, clock = () => s.now;
    db = connectPostgres(process.env.DATABASE_URL);
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: s.requests.apiKey, maxPerMinute: 180 });
    const record = v => ({ ...v, clock, rateBudget: budget });
    const requests = record(s.requests), attempts = record(s.attempts), reports = record(s.reports), observations = record(s.observations);
    const directory = { findByRef: ref => rpc('directory', { method: 'findByRef', ref }), findByEmail: ref => rpc('directory', { method: 'findByEmail', ref }) };
    const policy = await OwnerFileOutboundDncPolicy.capture({ path: s.policyPath, scope: requests.scope, directory, clock }, new AbortController().signal);
    if (!policy.ok) throw Error('Synthetic approved policy unavailable');
    const contact = { ...record(s.contact), contactRevision: {
      matches: (tenant, fp) => tenant === requests.scope.tenantId && fp === clinikoCredentialFingerprint(requests.apiKey),
      read: fp => rpc('revision', fp) } };
    const dnc = { source: contact, automationPrincipalRef: s.automationPrincipalRef };
    const grant = family => ({ allows: query => rpc('grant', { family, method: 'allows', query }), current: () => process.connected });
    const history = (family, methods) => Object.fromEntries([
      ['current', () => process.connected], ...methods.map(method => [method, query => rpc('grant', { family, method, query })])
    ]);
    const native = async (input, init) => {
      const response = await rpc('native', { input: String(input), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body });
      if (response.failed) throw Error('Synthetic remote unavailable');
      return new Response(response.body, { status: response.status, headers: response.headers });
    };
    const runtime = new TwilioAbbyOutboundRuntime({ ...s.carrier, contextKey: Buffer.from(s.contextKey, 'base64'), now: clock },
      async () => { throw Error('A callback cannot launch or query a carrier call'); });
    const selected = runtime.binding();
    const stopPorts = { request: grant('request'), attempt: grant('attempt'), contact: grant('contact'),
      definition: { currentFor: selection => rpc('definition', selection) },
      record: { ...grant('record'), producerAdmitted: query => rpc('grant', { family: 'record', method: 'producerAdmitted', query }) },
      authority: grant('authority'), reports: history('reports', ['allowsHistoryRead', 'allowsRecordRead']),
      runtime, native, authentication: new TwilioOutboundReportAuthentication(Buffer.from(s.reportKey, 'base64'), { ref: selected.ref, bindingDigest: selected.bindingDigest }),
      effects: new PostgresOutboundEffectBarrier(db, requests.scope, outboundDncRecordBinding(dnc)) };
    const staffReviews = s.staffReviews && record(s.staffReviews);
    const staffReview = staffReviews && {
      config: { observations, attempts, reviews: staffReviews, maximumNativeRequests: 180 },
      ports: { authentication: new TwilioOutboundTerminalObservationAuthentication(Buffer.from(s.notificationKey, 'base64'),
          { ref: selected.ref, bindingDigest: selected.bindingDigest }),
        sources: history('notificationHistory', ['allowsHistoryRead', 'allowsObservationRead', 'allowsAttemptRead']),
        records: { ...grant('staffRecord'), producerAdmitted: query => rpc('grant', { family: 'staffRecord', method: 'producerAdmitted', query }) },
        history: history('staffHistory', ['allowsHistoryRead', 'allowsRecordRead']), native,
        effects: new PostgresOutboundEffectBarrier(db, requests.scope, outboundStaffReviewRecordBinding(staffReviews)) }
    };
    const delivery = TwilioOutboundStatusDelivery.create({
      ...(staffReview ? { staffReview } : {}),
      notifications: { config: { runtime, observations, attempts, key: Buffer.from(s.notificationKey, 'base64'), maximumNativeRequests: 180 },
        ports: { source: { read: () => rpc('source'), current: () => process.connected },
          record: { ...grant('notificationRecord'), producerAdmitted: query => rpc('grant', { family: 'notificationRecord', method: 'producerAdmitted', query }) },
          history: history('notificationHistory', ['allowsHistoryRead', 'allowsObservationRead', 'allowsAttemptRead']), native,
          effects: (scope, binding) => new PostgresOutboundEffectBarrier(db, scope, binding) } },
      stop: { config: { reports, stop: { requests, attempts, dnc, policy: policy.value, maximumNativeRequests: 60, deadlineMs: 15000 } }, ports: stopPorts },
      maximumNativeRequests: 180, deadlineMs: 5000 });
    if (!delivery.ok) throw Error('Synthetic receiver unavailable');
    receiver = twilioOutboundStatusReceiver({ runtime, delivery: delivery.value, deadlineMs: 5000, authority: grant('ingress'),
      sessionEffects: () => { throw Error('A callback cannot claim a session'); }, createCall: async () => { throw Error('A callback cannot create a conversation'); } });
    server = createServer(async (req, res) => { if (!await receiver.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    process.send?.({ kind: 'listening', port: server.address().port });
  } catch { process.send?.({ kind: 'workerError' }); await close(); }
});
