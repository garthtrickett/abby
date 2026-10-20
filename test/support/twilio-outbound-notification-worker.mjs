/** Synthetic cold-process witness. Only remote transport and explicit grants
 * cross IPC; recovery owns its emitted modules, budget and SQL connection.
 * The start message has no lost notification, report, session or call ID. */
const root = new URL('../../dist/runtime/src/', import.meta.url), load = p => import(new URL(p, root));
const { connectPostgres } = await load('storage/connect.js');
const { PostgresClinikoRequestBudget } = await load('storage/postgres-cliniko-request-budget.js');
const { PostgresOutboundCapacity } = await load('storage/postgres-outbound-capacity.js');
const { outboundCapacityOwnerBinding } = await load('core/outbound-capacity.js');
const { TwilioAbbyOutboundRuntime } = await load('voice/twilio-outbound-runtime.js');
const { TwilioOutboundTerminalObservationAuthentication } = await load('cliniko/twilio-outbound-terminal-observation.js');
const { recoverTwilioOutboundNotification } = await load('standalone/cliniko-twilio-outbound-notification-recovery.js');
let next = 0, started = false; const pending = new Map();
const rpc = (kind, data) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); process.send?.({ kind, id, data }); });
process.on('message', async m => {
  if (m?.kind === 'reply') { pending.get(m.id)?.(m.data); pending.delete(m.id); return; }
  if (m?.kind !== 'start' || started) return; started = true; let db;
  try {
    const s = m.data, clock = () => s.now; db = connectPostgres(process.env.DATABASE_URL);
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: s.observations.apiKey, maxPerMinute: 180 });
    const attempts = { ...s.call.attempts, clock, rateBudget: budget }, observations = { ...s.observations, clock, rateBudget: budget };
    const wire = kind => async (input, init) => {
      const r = await rpc(kind, { input: String(input), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)) });
      if (r.failed) throw Error('Synthetic remote unavailable'); return new Response(r.body, { status: r.status, headers: r.headers });
    };
    const runtime = new TwilioAbbyOutboundRuntime({ ...s.carrier, contextKey: Buffer.from(s.contextKey, 'base64'), now: clock }, wire('providerFetch'));
    const b = runtime.binding(), authentication = new TwilioOutboundTerminalObservationAuthentication(Buffer.from(s.key, 'base64'), { ref: b.ref, bindingDigest: b.bindingDigest });
    const grant = family => ({ allows: query => rpc('grant', { family, query }), current: () => process.connected });
    const history = { allowsHistoryRead: query => rpc('grant', { family: 'history', query }), allowsObservationRead: query => rpc('grant', { family: 'observation', query }),
      allowsAttemptRead: query => rpc('grant', { family: 'original', query }), current: () => process.connected };
    const ports = { runtime, authentication, history, native: wire('nativeFetch'), closure: grant('closure'),
      call: { record: grant('record'), authority: grant('call'), capacity: new PostgresOutboundCapacity(db, s.call.capacityScope, outboundCapacityOwnerBinding(s.call.campaignRef)) } };
    const result = await recoverTwilioOutboundNotification({ observations, call: { ...s.call, attempts } }, ports, s.binding, new AbortController().signal);
    process.send?.({ kind: 'result', data: result });
  } catch { process.send?.({ kind: 'workerError' }); }
  finally { await db?.destroy(); process.disconnect?.(); }
});
