import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from '../dist/events.js';
import { createTools } from '../dist/tools.js';
import { eventExtension } from '../dist/session.js';

function hooks(events) {
  const handlers = {};
  eventExtension(events, () => {})({ on(name, handler) { handlers[name] = handler; } });
  return handlers;
}
const boundary = { outcome: 'completed' };

test('boundary injection steers; queued events cannot leak into a critical section', async () => {
  const events = new Events();
  const h = hooks(events);
  events.push({ event: 'signal', signal: 15 }); // Arrived BEFORE begin.
  events.enter();
  assert.equal(h.turn_end(boundary), undefined);
  events.push({ event: 'signal', signal: 17 });
  assert.equal(events.size, 2);
  assert.equal(h.turn_end(boundary), undefined);
  await assert.rejects(events.poll(), /critical section/);
  events.leave();
  const result = h.turn_end(boundary);
  assert.equal(result.continue, true);
  assert.match(result.entries[0].content, /"signal":15.*"signal":17/);
  assert.equal(events.size, 0);
});

test('poll wakes on input, consumes exactly once, and is abortable', async () => {
  const events = new Events();
  const poll = events.poll();
  events.push({ event: 'timer', id: 'x' });
  assert.equal((await poll)[0].id, 'x');
  assert.equal(events.take().length, 0);
  const abort = new AbortController();
  const pending = events.poll(abort.signal);
  abort.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  const again = events.poll();
  events.push({ event: 'timer', id: 'y' });
  assert.equal((await again)[0].id, 'y');
});

test('one consumer; nonnested sections; explicit failure wakes waiters', async () => {
  const events = new Events();
  assert.throws(() => events.leave(), /Not in/);
  events.enter();
  assert.throws(() => events.enter(), /Already/);
  const pending = events.wait();
  await assert.rejects(events.wait(), /one event consumer/);
  events.fail(new Error('lost adapter'));
  await assert.rejects(pending, /lost adapter/);
});

test('tiny queue limit fails explicitly, never silently drops input', () => {
  const events = new Events(1);
  events.push({ event: 'timer' });
  assert.throws(() => events.push({ event: 'timer' }), /limit exceeded/);
  assert.throws(() => events.take(), /limit exceeded/);
});

test('delivery batches are bounded and sequence numbers are stable', () => {
  const events = new Events(70);
  for (let i = 0; i < 65; i++) events.push({ event: 'timer' });
  assert.equal(events.take().length, 64);
  assert.equal(events.take()[0].sequence, 65);
});

test('requested timers only enqueue events, including during critical sections', async () => {
  const events = new Events();
  const { tools, dispose } = createTools({ request() { throw new Error('unexpected syscall'); } }, events, '/unused');
  try {
    const timer = tools.find((t) => t.name === 'timer');
    const waiting = events.wait();
    await timer.execute('1', { action: 'set', id: 'deadline', delay_ms: 1 });
    await waiting;
    assert.equal(events.take()[0].id, 'deadline');
    await timer.execute('2', { action: 'set', id: 'cancel', delay_ms: 1000 });
    const result = await timer.execute('3', { action: 'cancel', id: 'cancel' });
    assert.equal(result.details.cancelled, true);
    assert.equal(events.size, 0);
    assert.ok(tools.every((t) => t.executionMode === 'sequential'));
  } finally { dispose(); }
});
