import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

export async function namespace(t, argv, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pid1-test-'));
  const child = spawn('unshare', ['--user', '--map-root-user', '--pid', '--fork', '--kill-child=KILL', '--mount-proc',
    resolve('build/pid1'), '--', ...argv], {
    env: { ...process.env, TEST_OUT: join(dir, 'out'), TEST_ERR: join(dir, 'err'), ...(typeof env === 'function' ? env(dir) : env) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
  child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
  const closed = once(child, 'close');
  const output = () => ({ stdout, stderr });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await rm(dir, { recursive: true, force: true });
  });
  return { child, closed, output, dir };
}

export function outputMatching(stream, pattern) {
  return new Promise((resolve, reject) => {
    let text = '';
    const data = (chunk) => {
      text += chunk;
      if (pattern.test(text)) { cleanup(); resolve(text); }
    };
    const close = () => { cleanup(); reject(new Error(`Stream closed before ${pattern}: ${text}`)); };
    const cleanup = () => { stream.off('data', data); stream.off('close', close); };
    stream.on('data', data).on('close', close);
  });
}
