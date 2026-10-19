import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { namespace, outputMatching } from './helpers.mjs';

for (const name of ['exits', 'signals', 'orphans', 'burst', 'errors']) {
  test(`real PID namespace: ${name}`, { timeout: 12000 }, async (t) => {
    const run = await namespace(t, [process.execPath, 'test/native-controller.mjs', name]);
    const [code, signal] = await run.closed;
    assert.equal(code, 0, JSON.stringify({ code, signal, ...run.output() }));
    assert.match(run.output().stdout, new RegExp(`PASS ${name}`));
  });
}

test('agent death leaves adapter inert rather than exiting or restarting', { timeout: 12000 }, async (t) => {
  const run = await namespace(t, [process.execPath, 'test/native-controller.mjs', 'inert']);
  await outputMatching(run.child.stderr, /remaining inert/);
  assert.equal(run.child.exitCode, null);
  assert.equal(run.child.signalCode, null);
});

test('refuses to act as an init on the host', () => {
  const result = spawnSync('build/pid1', ['--', '/bin/true'], { timeout: 1000, encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /private PID namespace/);
});
