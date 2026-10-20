/** Synthetic crash witness. Actual emitted recovery/adapter/native owners run
 * here; only remote transport/grants cross IPC. No sealed lost session context. */
const emitted = new URL('../../dist/runtime/src/', import.meta.url);
const load = path => import(new URL(path, emitted));
const { connectPostgres } = await load('storage/connect.js');
const { PostgresClinikoRequestBudget } = await load('storage/postgres-cliniko-request-budget.js');
const { PostgresOutboundEffectBarrier } = await load('storage/postgres-outbound-effect-barrier.js');
const { PostgresOutboundCapacity } = await load('storage/postgres-outbound-capacity.js');
const { outboundContactGuardOwnerBinding, outboundCapacityOwnerBinding } = await load('core/outbound-capacity.js');
const { recoverTwilioOutboundFinality } = await load('standalone/cliniko-twilio-outbound-finality-recovery.js');
const { TwilioAbbyOutboundRuntime } = await load('voice/twilio-outbound-runtime.js');
const { TwilioOutboundReportAuthentication } = await load('cliniko/twilio-outbound-report.js');
const { OwnerFileOutboundContactAccount } = await load('standalone/owner-file-outbound-contact-account.js');
const { OwnerFileOutboundDncPolicy } = await load('standalone/owner-file-outbound-dnc-policy.js');
const { contactSourceSelection } = await load('cliniko/outbound-contact-source.js');
const { outboundDncRecordBinding } = await load('cliniko/outbound-dnc-records.js');
const { outboundContactOutcomeRecordBinding } = await load('cliniko/outbound-contact-outcome-records.js');
const { clinikoCredentialFingerprint } = await load('cliniko/read-budget.js');
let next = 0, started = false;
const pending = new Map();
const rpc = (kind, data) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); process.send?.({ kind, id, data }); });
process.on('message', async message => {
  if (message?.kind === 'reply') { pending.get(message.id)?.(message.data); pending.delete(message.id); return; }
  if (message?.kind !== 'start' || started) return; started = true; let db;
  try {
    const s = message.data, clock = () => s.now; db = connectPostgres(process.env.DATABASE_URL);
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: s.requests.apiKey, maxPerMinute: 180 });
    const requests = { ...s.requests, clock, rateBudget: budget }, attempts = { ...s.attempts, clock, rateBudget: budget };
    const reports = { ...s.reports, clock, rateBudget: budget }, outcomes = { ...s.outcomes, clock, rateBudget: budget };
    const directory = { findByRef: ref => rpc('directory', { method: 'findByRef', ref }), findByEmail: ref => rpc('directory', { method: 'findByEmail', ref }) };
    const definition = { currentFor: selection => rpc('definition', selection) };
    const source = { ...s.contact, clock, rateBudget: budget, contactRevision: { matches: (tenant, fp) => tenant === requests.scope.tenantId && fp === clinikoCredentialFingerprint(requests.apiKey), read: fp => rpc('revision', fp) } };
    const account = await OwnerFileOutboundContactAccount.capture({ path: s.accountPath, scope: requests.scope, credentialFingerprint: clinikoCredentialFingerprint(requests.apiKey), directory, clock,
      definitions: [{ selection: contactSourceSelection(source), definition }] }, new AbortController().signal);
    const policy = await OwnerFileOutboundDncPolicy.capture({ path: s.policyPath, scope: requests.scope, directory, clock }, new AbortController().signal);
    if (!account.ok || !policy.ok) throw Error('Synthetic source unavailable');
    const dnc = { source, automationPrincipalRef: s.automationPrincipalRef };
    const grant = family => ({ allows: query => rpc('grant', { family, query }), current: () => process.connected });
    const fetchPort = kind => async (input, init) => {
      const r = await rpc(kind, { input: String(input), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body });
      if (r.failed) throw Error('Synthetic remote unavailable'); return new Response(r.body, { status: r.status, headers: r.headers });
    };
    const runtime = new TwilioAbbyOutboundRuntime({ ...s.carrier, contextKey: Buffer.from(s.contextKey, 'base64'), now: clock }, fetchPort('providerFetch'));
    const binding = runtime.binding(), authentication = new TwilioOutboundReportAuthentication(Buffer.from(s.reportKey, 'base64'), { ref: binding.ref, bindingDigest: binding.bindingDigest });
    const config = { reports, contact: { stop: { requests, attempts, dnc, policy: policy.value, maximumNativeRequests: 60, deadlineMs: 15000 }, outcomes,
      account: account.value, guardRef: s.guardRef, capacityScope: requests.scope, maximumNativeRequests: 100, deadlineMs: 15000 },
      call: { attempts, campaignRef: s.campaignRef, capacityScope: requests.scope, maximumNativeRequests: 10, deadlineMs: 15000 } };
    const history = { allowsHistoryRead: query => rpc('grant', { family: 'runtimeHistory', query }), allowsReportRead: query => rpc('grant', { family: 'runtimeReport', query }),
      allowsAttemptRead: query => rpc('grant', { family: 'runtimeAttempt', query }), current: () => process.connected };
    const ports = { native: fetchPort('nativeFetch'), adapter: { runtime, authentication, history, closure: grant('closure') },
      contact: { stop: { request: grant('request'), attempt: grant('attempt'), contact: grant('contact'), definition,
        record: { ...grant('dnc'), producerAdmitted: query => rpc('grant', { family: 'dncProducer', query }) },
        effects: new PostgresOutboundEffectBarrier(db, requests.scope, outboundDncRecordBinding(dnc)), authority: grant('stop') },
        outcomes: { ...grant('outcome'), producerAdmitted: query => rpc('grant', { family: 'outcomeProducer', query }) },
        history: { allowsHistoryRead: query => rpc('grant', { family: 'outcomeHistory', query }), allowsRecordRead: query => rpc('grant', { family: 'outcomeRecord', query }), current: () => process.connected },
        outcomeEffects: new PostgresOutboundEffectBarrier(db, requests.scope, outboundContactOutcomeRecordBinding(outcomes)),
        authority: grant('settlement'), capacity: new PostgresOutboundCapacity(db, requests.scope, outboundContactGuardOwnerBinding(s.guardRef)) },
      call: { record: grant('attempt'), authority: grant('call'), capacity: new PostgresOutboundCapacity(db, requests.scope, outboundCapacityOwnerBinding(s.campaignRef)) } };
    process.send?.({ kind: 'result', data: await recoverTwilioOutboundFinality(config, ports, s.binding, new AbortController().signal) });
  } catch { process.send?.({ kind: 'workerError' }); }
  finally { await db?.destroy(); process.disconnect?.(); }
});
