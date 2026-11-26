import assert from 'node:assert/strict';
import test from 'node:test';
import { tabSwitchDebug } from '../public/tab-switch-debug.js';

test('a superseded switch stays quiet and a slow switch logs once before completion', (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const warn = t.mock.method(console, 'warn', () => {});
  const info = t.mock.method(console, 'info', () => {});

  const socket = { readyState: 1, bufferedAmount: 0 };
  const debug = tabSwitchDebug(false);
  const first = debug.start(socket, '@1', '@0', 'click');
  const second = debug.start(socket, '@2', '@0', 'click');
  debug.progress({ id: first.id, stage: 'tmux replied' });
  debug.progress({ id: second.id, stage: 'received' });

  now = 510;
  t.mock.timers.tick(500);
  assert.equal(warn.mock.callCount(), 1);
  const [, warning, details] = warn.mock.calls[0].arguments;
  assert.equal(warning, 'still pending');
  assert.equal(details.id, second.id);
  assert.equal(details.stage, 'received');

  debug.applied({ id: first.id }, '@1', performance.now());
  debug.applied({ id: second.id, tmuxReplyMs: 510 }, '@2', performance.now());
  t.mock.timers.tick(10_000);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(info.mock.callCount(), 1);
  const [, outcome, result] = info.mock.calls[0].arguments;
  assert.equal(outcome, 'applied');
  assert.equal(result.active, '@2');
  assert.equal(result.daemon.tmuxReplyMs, 510);

  // The new state can be handled before an overdue timer gets a turn.
  const late = debug.start(socket, '@3', '@2', 'keyboard');
  now += 600;
  debug.applied({ id: late.id }, '@3', now);
  assert.equal(warn.mock.callCount(), 2);
  assert.equal(warn.mock.calls[1].arguments[2].elapsedMs, 600);
  assert.equal(info.mock.callCount(), 2);
});
