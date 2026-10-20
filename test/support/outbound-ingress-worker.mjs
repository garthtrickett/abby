import { isDeepStrictEqual } from 'node:util';
const emitted = new URL('../../dist/runtime/src/', import.meta.url);
const { connectPostgres } = await import(new URL('storage/connect.js', emitted));
const { PostgresOutboundEffectBarrier } = await import(new URL('storage/postgres-outbound-effect-barrier.js', emitted));
const { TwilioAbbyOutboundRuntime } = await import(new URL('voice/twilio-outbound-runtime.js', emitted));
const { TwilioOutboundIngress } = await import(new URL('voice/twilio-outbound-ingress.js', emitted));
const { TwilioSignedIngress } = await import(new URL('voice/twilio-signed-ingress.js', emitted));
const { createTwilioIngressServer } = await import(new URL('voice/twilio-ingress-server.js', emitted));
process.once('message', async setup => {
  const db = connectPostgres(process.env.DATABASE_URL);
  const config = { ...setup.config, contextKey: new Uint8Array(setup.config.contextKey), now: () => setup.now };
  const runtime = new TwilioAbbyOutboundRuntime(config), binding = runtime.binding();
  const allowed = query => isDeepStrictEqual(query.call.context.original.attempt.scope, setup.scope) &&
    query.call.context.attemptDigest === setup.attemptDigest && isDeepStrictEqual(query.provider, binding);
  const outbound = new TwilioOutboundIngress({ runtime,
    authority: { allows: async q => allowed(q), current: q => allowed(q) },
    sessionEffects: (scope, owner) => new PostgresOutboundEffectBarrier(db, scope, owner),
    async createCall() { process.send({ kind: 'constructing' }); return new Promise(() => {}); }
  });
  const ingress = new TwilioSignedIngress({ accountSid: config.accountSid, authToken: config.authToken,
    publicWebhookUrl: 'https://clinic.example.invalid/inbound', publicStreamUrl: 'wss://clinic.example.invalid/inbound/stream',
    fallbackNumbers: { [config.from]: '+61255550999' }, bindingKey: new Uint8Array(32).fill(9), now: () => new Date(setup.now) });
  const server = createTwilioIngressServer({ ingress, outbound, async createCall() { throw Error('No inbound owner'); } });
  server.listen(0, '127.0.0.1', () => process.send({ kind: 'ready', port: server.address().port }));
});
