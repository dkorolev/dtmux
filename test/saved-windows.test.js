import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orderTabs } from '../public/tmux-util.js';

process.env.DTMUX_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmux-saved-'));
const { saveOnStop, savedFor, takeSaved, addSaved, saveTabOrder, tabOrderFor, SAVED_FILE } = await import('../server/saved-windows.js');

const live = (session, index, id, name, dir, autoName = false) => ({ session, index, id, name, dir, autoName });

test('stop saves live windows per session, in tab order, with ids', () => {
  const n = saveOnStop([
    live('dtmux', 2, 'b', 'logs', '/var/log'),
    live('dtmux', 0, 'a', 'zsh', '/tmp', true),
    live('other', 0, '', 'x', '/usr'),
  ]);
  assert.equal(n, 3);
  assert.deepEqual(
    savedFor('dtmux').map((w) => [w.id, w.name, w.dir, w.autoName]),
    [
      ['a', 'zsh', '/tmp', true],
      ['b', 'logs', '/var/log', false],
    ],
  );
  const [other] = savedFor('other');
  assert.match(other.id, /^[0-9a-f-]{36}$/, 'a window without an id gets a UUID');
  assert.equal(JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')).version, 1);
});

test('reopening takes a window out; the rest survive the next stop after the live ones', () => {
  assert.equal(takeSaved('dtmux', 'a').name, 'zsh');
  assert.equal(takeSaved('dtmux', 'a'), null, 'only once');
  // After restart, "a" was reopened (live again, same id) plus a new window "c".
  saveOnStop([live('dtmux', 0, 'c', 'new', '/'), live('dtmux', 1, 'a', 'zsh', '/tmp', true)]);
  assert.deepEqual(
    savedFor('dtmux').map((w) => w.id),
    ['c', 'a', 'b'],
  );
  assert.equal(savedFor('other').length, 1, 'sessions nobody opened are kept');
});

test('a fresh window that looks like a saved one stands in for it, one for one', () => {
  saveOnStop([]); // keep what is there
  const before = savedFor('other'); // one "x" in /usr
  // After restart: tmux made a fresh "x" in /usr (new id), and another one too.
  saveOnStop([live('other', 0, 'f1', 'x', '/usr'), live('other', 1, 'f2', 'x', '/usr')]);
  assert.deepEqual(
    savedFor('other').map((w) => w.id),
    ['f1', 'f2'],
    `the saved ${before[0].id} is absorbed by f1, not kept as a third copy`,
  );
});

test('a stop with no tmux running keeps everything saved', () => {
  const before = savedFor('dtmux');
  saveOnStop([]);
  assert.deepEqual(savedFor('dtmux'), before);
});

test('a disconnected window is saved like a stopped one, once per id, and can be forgotten', () => {
  addSaved('disc', { id: 'd1', name: 'work', autoName: false, dir: '/tmp' });
  addSaved('disc', { id: 'd1', name: 'work2', autoName: false, dir: '/usr' });
  assert.deepEqual(savedFor('disc').map((w) => [w.id, w.name, w.dir]), [['d1', 'work2', '/usr']]);
  const stored = JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')).sessions.disc;
  assert.equal(stored.length, 1);
  assert.equal(takeSaved('disc', 'd1').name, 'work2');
  assert.deepEqual(savedFor('disc'), []);
});

test('saved windows keep their branch and agent, and drop anything else', () => {
  addSaved('agents', { id: 'a1', name: 'w', dir: '/tmp', branch: 'feature', agent: { name: 'Claude Code', command: 'claude --resume x' }, junk: 1 });
  addSaved('agents', { id: 'a2', name: 'v', dir: '/tmp', branch: '', agent: { name: 'Codex' } });
  assert.deepEqual(savedFor('agents'), [
    { id: 'a1', name: 'w', autoName: false, dir: '/tmp', branch: 'feature', agent: { name: 'Claude Code', command: 'claude --resume x' } },
    { id: 'a2', name: 'v', autoName: false, dir: '/tmp' },
  ]);
  const n = saveOnStop([{ session: 'agents', index: 0, id: 'a3', name: 'x', dir: '/', autoName: false, branch: 'main', agent: { name: 'Codex', command: 'codex resume --last' } }]);
  assert.ok(n >= 3);
  assert.deepEqual(savedFor('agents')[0].agent, { name: 'Codex', command: 'codex resume --last' });
  assert.equal(savedFor('agents')[0].branch, 'main');
});

test('a window of several panes keeps each pane and its layout', async () => {
  const { parsePanes, panesOf, agentsByPane } = await import('../server/window-panes.js');
  const out = [
    '@1\tb373,160x40,0,0{80x40,0,0,3,79x40,81,0}\t%3\t0\t/tmp',
    '@1\tb373,160x40,0,0{80x40,0,0,3,79x40,81,0}\t%4\t1\t/usr',
    '@2\tabcd,80x24,0,0,5\t%5\t1\t/',
  ].join('\n');
  const windows = parsePanes(out);
  assert.equal(windows.get('@1').panes.length, 2);
  const agents = agentsByPane([{ pane: '%4', window: '@1', active: true, dir: '/usr', agent: 'Codex', command: 'codex resume x' }]);
  const kept = panesOf(windows.get('@1'), agents);
  assert.deepEqual(kept.panes, [{ dir: '/tmp' }, { dir: '/usr', agent: { name: 'Codex', command: 'codex resume x' } }]);
  assert.equal(kept.activePane, 1);
  assert.deepEqual(panesOf(windows.get('@2'), agents), {}, 'one pane: nothing extra');
  addSaved('panes', { id: 'p1', name: 'two', dir: '/usr', ...kept });
  const [e] = savedFor('panes');
  assert.equal(e.panes.length, 2);
  assert.equal(e.layout, 'b373,160x40,0,0{80x40,0,0,3,79x40,81,0}');
  assert.equal(e.activePane, 1);
  addSaved('panes', { id: 'p2', name: 'bad', dir: '/', panes: [{ dir: '/' }, { dir: '/' }], layout: 'not a layout' });
  assert.equal(savedFor('panes')[1].panes, undefined, 'a bad layout keeps the window as one pane');
  addSaved('panes', { id: 'p3', name: 'remote', dir: '/', remote: { name: 'h', host: 'x' }, ...kept });
  assert.equal(savedFor('panes')[2].panes, undefined, 'a remote tab has one pane here');
});

test('the toolbar restores mixed tab order from disk and appends newly recovered windows', async () => {
  const session = 'ordered';
  addSaved(session, { id: 'remote', name: 'worker', dir: '/tmp', remote: { name: 'cloud', host: 'worker' } });
  saveTabOrder(session, ['b', 'remote', 'a']);
  saveOnStop([
    live(session, 0, 'a', 'first', '/tmp'),
    live(session, 1, 'b', 'second', '/tmp'),
    live(session, 2, 'recovered', 'recovered', '/tmp'),
  ]);

  const restored = await import('../server/saved-windows.js?reload-tab-order');
  assert.deepEqual(restored.tabOrderFor(session), ['b', 'remote', 'a']);
  assert.equal(restored.tabOrderFor('other'), null);
  const items = restored.savedFor(session).map((w) => ({ key: w.id, w }));
  const { tabs, order } = orderTabs(restored.tabOrderFor(session), items);
  assert.deepEqual(order, ['b', 'remote', 'a', 'recovered']);
  assert.deepEqual(tabs.map((tab) => tab.key), order);
  assert.equal(tabs[1].w.remote.host, 'worker');
  assert.deepEqual(tabOrderFor(session), ['b', 'remote', 'a']);
});

test('crash recovery saves watcher targets and preserves separate tabs for the same session', async () => {
  const { parseLive } = await import('../server/live-snapshot.js');
  const watch = { host: 'observer@example.invalid', session: 'work' };
  addSaved('watchers', { id: 'dotted', name: 'watch', dir: '/tmp', watch });
  const recovered = parseLive('watchers\t0\tlive\t0\t@1\t/tmp\t\tobserver@example.invalid/work\twatch');
  saveOnStop(recovered);
  assert.deepEqual(savedFor('watchers').map((w) => [w.id, w.watch]), [['live', watch], ['dotted', watch]]);
  assert.equal(JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')).sessions.watchers[0].watch.host, watch.host);
});
