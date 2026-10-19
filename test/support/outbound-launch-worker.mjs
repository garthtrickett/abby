/** Synthetic compiled owner process. All private data travels by IPC only. */
const emitted = new URL('../../dist/runtime/src/', import.meta.url);
const { ClinikoOutboundLaunchOwner, outboundLaunchOwnerBinding } = await import(new URL('standalone/cliniko-outbound-launch-owner.js', emitted));
const { OwnerFileOutboundCampaign } = await import(new URL('standalone/owner-file-outbound-campaign.js', emitted));
const { PostgresOutboundCapacity } = await import(new URL('storage/postgres-outbound-capacity.js', emitted));
const { PostgresOutboundEffectBarrier } = await import(new URL('storage/postgres-outbound-effect-barrier.js', emitted));
const { PostgresClinikoRequestBudget } = await import(new URL('storage/postgres-cliniko-request-budget.js', emitted));
const { connectPostgres } = await import(new URL('storage/connect.js', emitted));
const { outboundCapacityOwnerBinding } = await import(new URL('core/outbound-capacity.js', emitted));
const { outboundLaunchRecordOwnerBinding } = await import(new URL('cliniko/outbound-launch-records.js', emitted));
const { clinikoCredentialFingerprint } = await import(new URL('cliniko/read-budget.js', emitted));
let next = 0, started = false;
const pending = new Map();
const rpc = (kind, data) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); process.send?.({ kind, id, data }); });
process.on('message', async message => {
  if (message?.kind === 'reply') { pending.get(message.id)?.(message.data); pending.delete(message.id); return; }
  if (message?.kind !== 'start' || started) return; started = true;
  let db;
  try {
    const setup = message.data, clock = () => setup.now;
    db = connectPostgres(process.env.DATABASE_URL);
    const rateBudget = new PostgresClinikoRequestBudget(db, { apiKey: setup.requests.apiKey, maxPerMinute: 180 });
    const directory = { findByRef: ref => rpc('directory', { method: 'findByRef', ref }), findByEmail: ref => rpc('directory', { method: 'findByEmail', ref }) };
    const campaign = await OwnerFileOutboundCampaign.capture({ path: setup.campaignPath, scope: setup.requests.scope, directory, clock }, new AbortController().signal);
    if (!campaign.ok) throw new Error('Synthetic campaign unavailable');
    const requests = { ...setup.requests, clock, rateBudget }, attempts = { ...setup.attempts, clock, rateBudget };
    const config = { requests, attempts, contact: { ...setup.contact, clock, rateBudget,
      contactRevision: { matches: (tenant, fingerprint) => tenant === requests.scope.tenantId && fingerprint === clinikoCredentialFingerprint(requests.apiKey),
        read: fingerprint => rpc('revision', fingerprint) } },
      campaignRef: setup.campaignRef, campaign: campaign.value, maximumNativeRequests: 150, dispatchWindowMs: 10000, deadlineMs: 15000 };
    if (setup.individualTarget) config.individualTarget = setup.individualTarget;
    const grant = family => ({ allows: query => rpc('grant', { family, query }), current: () => process.connected });
    const native = async (input, init) => {
      const value = await rpc('fetch', { input: String(input), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body });
      if (value.failed) throw new Error('Synthetic native unavailable');
      return new Response(value.body, { status: value.status });
    };
    const owner = ClinikoOutboundLaunchOwner.create(config, {
      request: grant('request'), attempt: { ...grant('attempt'), producerAdmitted: query => rpc('grant', { family: 'attemptProducer', query }) },
      history: { allowsHistoryRead: query => rpc('grant', { family: 'history', query }), allowsRecordRead: query => rpc('grant', { family: 'historyRecord', query }), current: () => process.connected },
      contact: grant('contact'), contactDefinition: { currentFor: selection => rpc('definition', selection) }, authority: grant('authority'),
      ...(setup.individualTarget ? { target: grant('target') } : {}),
      effects: new PostgresOutboundEffectBarrier(db, requests.scope, outboundLaunchOwnerBinding(config)),
      attemptEffects: new PostgresOutboundEffectBarrier(db, requests.scope, outboundLaunchRecordOwnerBinding(attempts)),
      capacity: new PostgresOutboundCapacity(db, requests.scope, outboundCapacityOwnerBinding(config.campaignRef)), native,
      provider: { binding: () => setup.provider,
        async launchOnce(payload, _signal, beforeSend, acknowledged) {
          if (!await beforeSend()) return { kind: 'definitiveUnsent' };
          const value = await rpc('provider', payload);
          if (value?.kind === 'accepted' && value.effectRef === payload.effectRef) acknowledged(payload.effectRef);
          return value;
        } },
    });
    if (!owner.ok) throw new Error('Synthetic owner unavailable');
    const result = await owner.value.launchOnce(setup.binding, new AbortController().signal);
    process.send?.({ kind: 'result', data: result });
  } catch { process.send?.({ kind: 'workerError' }); }
  finally { await db?.destroy(); process.disconnect?.(); }
});
