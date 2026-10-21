import { spawn } from 'node:child_process';

// An absolute loader URL survives the empty working directories used by cold
// recovery children. Preserve all original test selectors and Node arguments.
const child = spawn(process.execPath, [...process.execArgv, '--import', new URL('./test-typescript-loader.mjs', import.meta.url).href, ...process.argv.slice(2)], { stdio: 'inherit' });
const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => {
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1;
});
