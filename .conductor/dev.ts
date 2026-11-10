// Conductor actions share one runner so both servers agree on the workspace's ports.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const mode = process.argv[2] ?? 'app';
if (!['app', 'backend', 'frontend'].includes(mode)) throw new Error('Use app, backend, or frontend.');
const port = Number(process.env.CONDUCTOR_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65526) throw new Error('CONDUCTOR_PORT must leave room for the API port.');
const api = `http://127.0.0.1:${port + 1}`;
const repo = process.env.CONDUCTOR_ROOT_PATH ?? process.cwd();
const candidates = process.env.EXACT2 ? [process.env.EXACT2] : [resolve(repo, '../exact'), resolve(process.cwd(), '../exact')];
const exact = candidates.find((path) => existsSync(resolve(path, 'scripts/app-cli.mjs')));
if (mode !== 'backend' && !exact) throw new Error('Set EXACT2 to your Exact checkout before starting the frontend.');
const env = { ...process.env, API_BASE_URL: api, HOST: '127.0.0.1', PORT: String(port + 1), ...(exact ? { EXACT2: exact } : {}) };
const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  const timeout = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }, 3000);
  await Promise.allSettled(children.map((child) => child.exited));
  clearTimeout(timeout);
  process.exit(code);
}
process.on('SIGINT', () => { void stop(0); });
process.on('SIGTERM', () => { void stop(0); });
const launch = (args: string[]) => children.push(Bun.spawn([process.execPath, ...args], {
  cwd: process.cwd(), env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', detached: false,
}));
console.log(`Frontend: http://localhost:${port}\nBackend: ${api}`);
if (mode !== 'frontend') launch(['server/index.ts']);
if (mode !== 'backend') launch(['exact.mjs', 'web', '--port', String(port)]);
const exit = await Promise.race(children.map((child) => child.exited));
await stop(exit);
