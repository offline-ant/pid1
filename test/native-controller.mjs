import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { Adapter } from '../dist/adapter.js';
import { Events } from '../dist/events.js';

const events = new Events();
const adapter = new Adapter(new Socket({ fd: Number(process.env.PID1_CONTROL_FD), readable: true, writable: true }), (e) => events.push(e));
const signal = AbortSignal.timeout(8000);
async function event(number) {
  for (;;) {
    for (const e of await events.poll(signal)) if (e.event === 'signal' && e.signal === number) return e;
  }
}
async function spawn(argv, env = []) {
  return adapter.request('spawn', [process.cwd(), process.env.TEST_OUT, process.env.TEST_ERR, String(env.length / 2), ...env, ...argv]);
}
async function collect(pid) {
  for (;;) {
    const status = await adapter.request('wait', [String(pid)]);
    if (status.pid) return status;
    await event(17);
  }
}
const cases = {
  async exits() {
    const boot = (await events.poll(signal)).find((e) => e.event === 'boot');
    assert.equal(boot.adapter_pid, 1);
    assert.equal(boot.agent_pid, process.pid);
    const { pid } = await spawn(['/bin/sh', '-c', 'echo hello; exit 7']);
    await event(17);
    assert.match(await readFile(`/proc/${pid}/stat`, 'utf8'), /\) Z /);
    assert.equal(await readFile(process.env.TEST_OUT, 'utf8'), 'hello\n');
    assert.equal((await collect(pid)).status, 7);
    await assert.rejects(readFile(`/proc/${pid}/stat`), { code: 'ENOENT' });
    assert.equal((await adapter.request('wait', [String(pid)])).no_children, true);
    assert.equal((await adapter.request('wait', ['-1'])).no_children, false); // Agent is alive.
  },
  async signals() {
    await adapter.request('signal', ['1', '15']);
    assert.equal((await event(15)).signal, 15);
    // SIGTERM neither forwards nor exits PID 1.
    const { pid } = await spawn(['/bin/sleep', '100']);
    await adapter.request('signal', [String(pid), '19']);
    assert.equal((await collect(pid)).state, 'stopped');
    await adapter.request('signal', [String(pid), '18']);
    assert.equal((await collect(pid)).state, 'continued');
    await adapter.request('signal', [String(-pid), '15']);
    const status = await collect(pid);
    assert.equal(status.state, 'signaled');
    assert.equal(status.signal, 15);
  },
  async orphans() {
    const { pid } = await spawn(['/bin/sh', '-c', 'sleep 100 & echo $!; exit 0']);
    assert.equal((await collect(pid)).status, 0);
    const orphan = Number((await readFile(process.env.TEST_OUT, 'utf8')).trim());
    const stat = (await readFile(`/proc/${orphan}/stat`, 'utf8')).split(') ')[1].split(' ');
    assert.equal(Number(stat[1]), 1);
    assert.equal(Number(stat[2]), pid);
    await adapter.request('signal', [String(-pid), '15']);
    assert.equal((await collect(orphan)).signal, 15);
  },
  async burst() {
    const pids = [];
    for (let i = 0; i < 12; i++) pids.push((await spawn(['/bin/sh', '-c', `exit ${i}`])).pid);
    // Reap by identity, without assuming one notification per exit.
    for (let i = 0; i < pids.length; i++) assert.equal((await collect(pids[i])).status, i);
  },
  async errors() {
    await assert.rejects(adapter.request('wait', ['0']), /EINVAL/);
    await assert.rejects(adapter.request('signal', ['2147483647', '15']), /ESRCH/);
    await assert.rejects(adapter.request('unknown'), /ENOSYS/);
    await assert.rejects(spawn(['/bin/true'], ['BAD=KEY', 'x']), /EINVAL/);
    const { pid } = await spawn(['/not/a/program']);
    assert.equal((await collect(pid)).status, 127);
    assert.match(await readFile(process.env.TEST_ERR, 'utf8'), /execvp/);
    const child = await spawn(['/bin/sh', '-c', 'test -z "$PID1_CONTROL_FD" && test ! -e /proc/self/fd/3 && test "$EXPERIMENT" = yes'], ['EXPERIMENT', 'yes']);
    assert.equal((await collect(child.pid)).status, 0);
  },
  async inert() {
    await spawn(['/bin/sleep', '100']);
    console.log('controller exiting without policy');
    adapter.close();
    process.exit(0);
  },
};
try {
  await cases[process.argv[2]]();
  console.log(`PASS ${process.argv[2]}`);
  adapter.request('exit', ['0']).catch(() => {});
} catch (error) {
  console.error(error);
  adapter.request('exit', ['1']).catch(() => {});
}
