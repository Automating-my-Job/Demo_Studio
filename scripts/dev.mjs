/**
 * dev.mjs — starts the vite renderer dev server, waits for it, then launches
 * Electron pointed at it. Ctrl-C tears both down.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5183;

const vite = spawn('npx', ['vite'], { cwd: rootDir, stdio: 'inherit' });

function waitForPort(port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error('vite dev server did not come up'));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

await waitForPort(PORT, 30000);

const electron = spawn('npx', ['electron', '.'], {
  cwd: rootDir,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:' + PORT },
});

const shutdown = () => { try { vite.kill(); } catch {} try { electron.kill(); } catch {} };
electron.on('exit', () => { shutdown(); process.exit(0); });
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
