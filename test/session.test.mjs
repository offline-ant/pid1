import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitSession } from '../dist/session.js';
import { Events } from '../dist/events.js';

function response(model, content) {
  const message = {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content, stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  return {
    result: async () => message,
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: message };
      yield { type: 'done', reason: message.stopReason, message };
    },
  };
}
const call = (id, name, args) => ({ type: 'toolCall', id: String(id), name, arguments: args });

async function runtime(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pid1-session-'));
  const env = { ...process.env };
  // Empty, isolated auth/model paths: these tests replace the stream function,
  // never use real credentials or a provider connection.
  process.env.PID1_AUTH_PATH = join(dir, 'auth.json');
  process.env.PID1_MODELS_PATH = join(dir, 'models.json');
  const events = new Events();
  const logs = [];
  const r = await createInitSession({ request() { throw new Error('unexpected syscall'); } }, events, dir, (type, data) => logs.push({ type, ...data }));
  t.after(async () => {
    r.dispose();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(dir, { recursive: true, force: true });
  });
  return { ...r, events, logs };
}

test('real Pi SDK: critical sections gate delivery across provider turns', { timeout: 10000 }, async (t) => {
  const { session, events, logs } = await runtime(t);
  let turn = 0;
  session.agent.streamFunction = (model, context) => {
    turn++;
    const transcript = JSON.stringify(context);
    if (turn === 1) {
      events.push({ event: 'test', marker: 'BEFORE_BEGIN' });
      return response(model, [call(turn, 'critical_section', { action: 'begin' })]);
    }
    if (turn === 2) {
      assert.doesNotMatch(transcript, /BEFORE_BEGIN/);
      events.push({ event: 'test', marker: 'DURING_SECTION' });
      return response(model, [call(turn, 'timer', { action: 'set', id: 'unused', delay_ms: 100000 })]);
    }
    if (turn === 3) {
      assert.doesNotMatch(transcript, /BEFORE_BEGIN|DURING_SECTION/);
      return response(model, [call(turn, 'critical_section', { action: 'end' })]);
    }
    assert.equal(turn, 4);
    assert.match(transcript, /BEFORE_BEGIN/);
    assert.match(transcript, /DURING_SECTION/);
    return response(model, [{ type: 'text', text: 'settled' }]);
  };
  await session.sendCustomMessage({ customType: 'pid1.events', content: 'Startup task', display: true }, { triggerTurn: true });
  assert.equal(turn, 4, JSON.stringify(logs));
  assert.equal(events.size, 0);
  assert.equal(events.locked, false);
  assert.equal(logs.filter((l) => l.type === 'delivered').length, 1);
  assert.equal(logs.filter((l) => l.type === 'extension_error').length, 0);
});

test('real Pi SDK: explicit poll returns input once, without steering duplication', { timeout: 10000 }, async (t) => {
  const { session, events } = await runtime(t);
  let turn = 0;
  session.agent.streamFunction = (model, context) => {
    turn++;
    if (turn === 1) {
      queueMicrotask(() => events.push({ event: 'test', marker: 'POLL_RESULT' }));
      return response(model, [call(turn, 'poll_next', {})]);
    }
    assert.equal(turn, 2);
    assert.match(JSON.stringify(context), /POLL_RESULT/);
    return response(model, [{ type: 'text', text: 'done' }]);
  };
  await session.sendCustomMessage({ customType: 'pid1.events', content: 'Startup task', display: true }, { triggerTurn: true });
  assert.equal(turn, 2);
  assert.equal(events.size, 0);
  assert.equal(session.messages.filter((m) => m.role === 'custom').length, 1);
});
