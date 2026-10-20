const emitted = new URL('../../dist/runtime/src/standalone/', import.meta.url);
let f;
try {
  const { ClinikoOutboundNumberStops } = await import(new URL('cliniko-outbound-number-stops.js', emitted));
  const { OwnerFileOutboundContactAccount } = await import(new URL('owner-file-outbound-contact-account.js', emitted));
  const { outboundNumberStopsFixture } = await import('./outbound-number-stops.ts');
  f = await outboundNumberStopsFixture({ Reader: ClinikoOutboundNumberStops, Account: OwnerFileOutboundContactAccount });
  f.stopOther(); const found = await f.read();
  if (!found.ok || found.value.disposition !== 'blocked') throw Error('Synthetic readonly result unavailable');
  process.stdout.write('readonly-native-number-stop\n');
} catch { process.exitCode = 1; }
finally { await f?.close(); }
