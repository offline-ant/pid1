import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const controller = `
import {Socket} from 'node:net';
import {Adapter} from '/app/dist/adapter.js';
import {Events} from '/app/dist/events.js';
import {readFile} from 'node:fs/promises';
const events = new Events();
const adapter = new Adapter(new Socket({fd:3,readable:true,writable:true}), e=>events.push(e));
try {
  if ((await events.poll())[0].adapter_pid !== 1) throw Error('not init');
  const {pid} = await adapter.request('spawn',['/workspace','/tmp/out','/tmp/err','0','/bin/sh','-c','echo image-ok; exit 7']);
  for (;;) {
    const state = await adapter.request('wait',[String(pid)]);
    if (state.pid) { if(state.status!==7) throw Error('bad status'); break; }
    await events.poll();
  }
  if ((await readFile('/tmp/out','utf8'))!=='image-ok\\n') throw Error('bad output');
  console.log('PASS container PID1 spawn/wait');
  adapter.request('exit',['0']).catch(()=>{});
} catch(error) {
  console.error(error);
  adapter.request('exit',['1']).catch(()=>{});
}
`;

test('built image: private PID1 control, spawn, wait and namespace exit', { timeout: 15000 }, async (t) => {
  const engine = process.env.PID1_ENGINE ?? 'podman';
  const image = process.env.PID1_IMAGE ?? 'localhost/pi-pid1:experiment';
  const name = `pi-pid1-smoke-${process.pid}`;
  const child = spawn(engine, ['run', '--rm', '--name', name, '--network=none', '--cap-drop=all',
    '--security-opt=no-new-privileges', '--entrypoint=/app/build/pid1', image,
    '--', 'node', '--input-type=module', '-e', controller], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      // Killing the client doesn't kill a detached container; remove it explicitly.
      const cleanup = spawn(engine, ['rm', '--force', name], { stdio: 'ignore' });
      await once(cleanup, 'close');
      child.kill('SIGKILL');
    }
    await closed;
  });
  const [code, signal] = await closed;
  assert.equal(code, 0, JSON.stringify({ code, signal, output }));
  assert.match(output, /PASS container PID1 spawn\/wait/);
});
