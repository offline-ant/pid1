import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { namespace, outputMatching } from './helpers.mjs';

// big: real provider/network latency; excluded from npm test. Explicit opt-in.
test('big: gpt-6.1-sol boots a workload and handles SIGTERM through tools', { timeout: 50000 }, async (t) => {
  assert.ok(process.env.PID1_LIVE_AUTH, 'Set PID1_LIVE_AUTH to an existing Pi auth.json');
  const authDir = await mkdtemp(join(tmpdir(), 'pi-pid1-live-auth-'));
  t.after(() => rm(authDir, { recursive: true, force: true }));
  const auth = join(authDir, 'auth.json');
  await copyFile(process.env.PID1_LIVE_AUTH, auth);
  await chmod(auth, 0o600); // Refreshes affect only this throwaway copy.
  const run = await namespace(t, [process.execPath, resolve('dist/main.js')], (dir) => ({
    PID1_AUTH_PATH: auth, PID1_MODELS_PATH: join(authDir, 'models.json'),
    PID1_STATE_DIR: join(dir, 'state'), PID1_THINKING: 'low',
    PID1_TASK_FILE: '', PID1_PROVIDER: 'openai-codex', PID1_MODEL: 'gpt-6.1-sol',
    PID1_TASK: 'Integration test. Initially spawn exactly one workload with argv ["/bin/sleep","100"]. Remember its PID. Then finish your turn and wait automatically for input. Do not set timers. On a SIGTERM event, signal that workload process group SIGTERM, collect its exit using wait (and poll_next if needed), drain available child statuses, then call exit with status 0. Do not exit until you have collected the workload exit. Keep text brief.',
  }));
  t.after(async () => {
    if (process.env.PID1_LIVE_LOG) await writeFile(process.env.PID1_LIVE_LOG, run.output().stdout + run.output().stderr);
  });
  await outputMatching(run.child.stdout, /"type":"idle"/);
  assert.match(run.output().stdout, /"tool":"spawn"/);
  const children = (await readFile(`/proc/${run.child.pid}/task/${run.child.pid}/children`, 'utf8')).trim().split(/\s+/).map(Number);
  assert.equal(children.length, 1);
  process.kill(children[0], 'SIGTERM');
  const [code, signal] = await run.closed;
  assert.equal(code, 0, JSON.stringify({ code, signal, ...run.output() }));
  const records = run.output().stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(records.some((r) => r.type === 'received' && r.event.signal === 15));
  for (const tool of ['signal', 'wait', 'exit']) assert.ok(records.some((r) => r.type === 'tool_start' && r.tool === tool), tool);
  assert.ok(records.some((r) => r.type === 'tool_end' && r.tool === 'wait' && /signaled|exited/.test(r.result)));
  assert.ok(!records.some((r) => r.type === 'fatal' || r.type === 'extension_error'));
});
