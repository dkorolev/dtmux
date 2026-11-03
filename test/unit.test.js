import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOutput, quote } from '../server/tmux-control.js';
import { trackKitty, kittyRestoreSequence, recordKittyCommand, forgetPane } from '../server/kitty-tracker.js';
import { macLineEdit, macWordEdit, orderTabs, parseLayout, paneBorders, tmuxKeyName, windowSwitchDirection } from '../public/tmux-util.js';
import { tokenize, parseBinding, fillTemplate } from '../server/tmux-bindings.js';
import { findResumeHint } from '../server/resume-hint.js';
import { planSwaps } from '../server/tmux-session.js';

test('decodeOutput turns octal escapes back into bytes and keeps raw UTF-8', () => {
  const line = Buffer.from('%output %1 a\\033[1m\\134x caf\xc3\xa9\\015\\012', 'latin1');
  const out = decodeOutput(line, '%output %1 '.length);
  assert.equal(out.toString('utf8'), 'a\x1b[1m\\x café\r\n');
});

test('quote escapes tmux double-quote specials', () => {
  assert.equal(quote('a"b$c\\d'), '"a\\"b\\$c\\\\d"');
});

test('kitty tracker follows push, pop and set, across chunk boundaries', () => {
  const p = '%900';
  forgetPane(p);
  assert.equal(trackKitty(p, Buffer.from('hello \x1b[>')), false);
  assert.equal(trackKitty(p, Buffer.from('5u world')), true); // push 5, split across chunks
  assert.equal(kittyRestoreSequence(p, 'claude'), '\x1b[=5;1u');
  recordKittyCommand(p, 'claude');
  assert.equal(kittyRestoreSequence(p, 'zsh'), ''); // a different program now
  trackKitty(p, Buffer.from('\x1b[=1;3u')); // clear bit 1
  assert.equal(kittyRestoreSequence(p, 'zsh'), '\x1b[=4;1u'); // flags changed, command unknown again
  trackKitty(p, Buffer.from('\x1b[<u')); // pop back to 0
  assert.equal(kittyRestoreSequence(p, 'zsh'), '');
});

test('parseLayout handles single panes and nested splits', () => {
  assert.deepEqual(parseLayout('a87d,100x30,0,0,0'), [{ id: '%0', x: 0, y: 0, w: 100, h: 30 }]);
  assert.deepEqual(parseLayout('419a,80x24,0,0[80x12,0,0,1,80x11,0,13,2]'), [
    { id: '%1', x: 0, y: 0, w: 80, h: 12 },
    { id: '%2', x: 0, y: 13, w: 80, h: 11 },
  ]);
  assert.deepEqual(
    parseLayout('c3a1,160x40,0,0{80x40,0,0,3,79x40,81,0[79x20,81,0,4,79x19,81,21,5]}').map((l) => l.id),
    ['%3', '%4', '%5'],
  );
});

test('paneBorders finds dividers and joins one split into a single drag', () => {
  assert.deepEqual(paneBorders([{ id: '%0', x: 0, y: 0, w: 80, h: 24 }]), []);
  assert.deepEqual(
    paneBorders([
      { id: '%1', x: 0, y: 0, w: 40, h: 24 },
      { id: '%2', x: 41, y: 0, w: 39, h: 24 },
    ]),
    [{ axis: 'x', at: 40, gap: 1, pane: '%1', origin: 0, lo: 0, hi: 24 }],
  );
  assert.deepEqual(
    paneBorders([
      { id: '%1', x: 0, y: 0, w: 80, h: 12 },
      { id: '%2', x: 0, y: 13, w: 80, h: 11 },
    ]),
    [{ axis: 'y', at: 12, gap: 1, pane: '%1', origin: 0, lo: 0, hi: 80 }],
  );
  assert.deepEqual(
    paneBorders([
      { id: '%3', x: 0, y: 0, w: 40, h: 24 },
      { id: '%4', x: 41, y: 0, w: 39, h: 12 },
      { id: '%5', x: 41, y: 13, w: 39, h: 11 },
    ]),
    [
      { axis: 'x', at: 40, gap: 1, pane: '%3', origin: 0, lo: 0, hi: 24 },
      { axis: 'y', at: 12, gap: 1, pane: '%4', origin: 0, lo: 41, hi: 80 },
    ],
  );
});

test('findResumeHint reads the leave-message of Claude, Codex, and Cursor', () => {
  assert.deepEqual(
    findResumeHint('Resume this session with:\r\n\x1b[2mclaude --resume 41c82cc4-a5a6-4519-9b5b-b411b78cfbb9\x1b[0m\n'),
    { agent: 'claude', command: 'claude --resume 41c82cc4-a5a6-4519-9b5b-b411b78cfbb9' },
  );
  assert.deepEqual(
    findResumeHint(
      'Disconnected from this task. Any running work continues.\nTo reconnect, run:\n  \x1b[36mcodex resume 01a19b8e-ae7f-7d53-9bb2-3d49a2c5aaef\x1b[39m\n',
    ),
    { agent: 'codex', command: 'codex resume 01a19b8e-ae7f-7d53-9bb2-3d49a2c5aaef' },
  );
  assert.deepEqual(findResumeHint('To continue this session, run:\ncodex resume\n'), {
    agent: 'codex',
    command: 'codex resume',
  });
  assert.deepEqual(
    findResumeHint(
      '\n  \x1b[90mTo resume this session:\x1b[0m \x1b[1m\x1b[36magent --resume=abc-123\x1b[0m\n',
    ),
    { agent: 'cursor', command: 'agent --resume=abc-123' },
  );
  assert.deepEqual(
    findResumeHint('To resume this session: cursor agent --resume=abc-123\n'),
    { agent: 'cursor', command: 'cursor agent --resume=abc-123' },
  );
  assert.deepEqual(
    findResumeHint('To resume the previous conversation use agent --resume abc-123\n'),
    { agent: 'cursor', command: 'agent --resume abc-123' },
  );
  assert.equal(findResumeHint('just talking about claude --resume someday'), null);
});

test('macWordEdit is Option+Left and Option+Right, as a word move', () => {
  const ev = (key, extra = {}) => ({ key, code: key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...extra });
  assert.equal(macWordEdit(ev('ArrowLeft', { altKey: true })), '\x1bb');
  assert.equal(macWordEdit(ev('ArrowRight', { altKey: true })), '\x1bf');
  assert.equal(macWordEdit(ev('ArrowLeft')), null);
  assert.equal(macWordEdit(ev('ArrowLeft', { altKey: true, metaKey: true })), null);
  assert.equal(macWordEdit(ev('ArrowLeft', { altKey: true, shiftKey: true })), null);
  assert.equal(macWordEdit(ev('b', { altKey: true, code: 'KeyB' })), null);
});

test('macLineEdit is Cmd+Left and Cmd+Right, as beginning and end of line', () => {
  const ev = (key, extra = {}) => ({ key, code: key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...extra });
  assert.equal(macLineEdit(ev('ArrowLeft', { metaKey: true })), '\x01');
  assert.equal(macLineEdit(ev('ArrowRight', { metaKey: true })), '\x05');
  assert.equal(macLineEdit(ev('ArrowLeft')), null);
  assert.equal(macLineEdit(ev('ArrowLeft', { metaKey: true, shiftKey: true })), null);
  assert.equal(macLineEdit(ev('ArrowLeft', { metaKey: true, altKey: true })), null);
  assert.equal(macLineEdit(ev('ArrowUp', { metaKey: true })), null);
});

test('windowSwitchDirection is only Ctrl+PageUp and Ctrl+PageDown', () => {
  const ev = (key, extra = {}) => ({ key, code: key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...extra });
  assert.equal(windowSwitchDirection(ev('PageDown', { ctrlKey: true })), 1);
  assert.equal(windowSwitchDirection(ev('PageUp', { ctrlKey: true })), -1);
  assert.equal(windowSwitchDirection(ev('PageDown')), 0);
  assert.equal(windowSwitchDirection(ev('PageDown', { ctrlKey: true, shiftKey: true })), 0);
  assert.equal(windowSwitchDirection(ev('PageDown', { ctrlKey: true, metaKey: true })), 0);
  assert.equal(windowSwitchDirection(ev('ArrowDown', { ctrlKey: true })), 0);
});

test('tmuxKeyName maps browser key events to tmux key names', () => {
  const ev = (key, extra = {}) => ({
    key,
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...extra,
  });
  assert.equal(tmuxKeyName(ev('a', { ctrlKey: true, code: 'KeyA' })), 'C-a');
  assert.equal(tmuxKeyName(ev('c', { code: 'KeyC' })), 'c');
  assert.equal(tmuxKeyName(ev('|', { shiftKey: true })), '|');
  assert.equal(tmuxKeyName(ev('"', { shiftKey: true })), '"');
  assert.equal(tmuxKeyName(ev('ArrowUp')), 'Up');
  assert.equal(tmuxKeyName(ev('ArrowUp', { shiftKey: true })), 'S-Up');
  assert.equal(tmuxKeyName(ev('PageDown', { ctrlKey: true })), 'C-NPage');
  assert.equal(tmuxKeyName(ev('Tab', { shiftKey: true })), 'BTab');
  assert.equal(tmuxKeyName(ev('¬', { altKey: true, code: 'KeyL' })), 'M-l');
  assert.equal(tmuxKeyName(ev('Shift', { shiftKey: true })), null);
});

test('tokenize splits tmux command strings like list-keys prints them', () => {
  const words = (s) => tokenize(s).map((c) => c.map((w) => (w.block ? `{${w.text}}` : w.text)));
  assert.deepEqual(words('source-file ~/.tmux.conf \\; display-message "a \\"b\\""'), [
    ['source-file', '~/.tmux.conf'],
    ['display-message', 'a "b"'],
  ]);
  assert.deepEqual(words(`new-window ; split-window -c '#{pane_current_path}'`), [
    ['new-window'],
    ['split-window', '-c', '#{pane_current_path}'],
  ]);
  assert.deepEqual(words('if -F x { a "}" ; b { c } }'), [['if', '-F', 'x', '{a "}" ; b { c }}']]);
});

test('parseBinding recognises prompts and confirmations that would wedge a control client', () => {
  assert.deepEqual(parseBinding('command-prompt -I "#W" { rename-window "%%" }'), {
    kind: 'prompt',
    prompts: ['(rename-window)'],
    inputs: ['#W'],
    template: 'rename-window "%%"',
    formatTemplate: false,
    single: false,
    numeric: false,
  });
  assert.deepEqual(parseBinding('command-prompt').prompts, [':']);
  assert.equal(parseBinding('command-prompt').template, '%1');
  const p = parseBinding("command-prompt -1N -p 'a,b' -I x,y { swap-window -s %1 -t %2 }");
  assert.deepEqual([p.prompts, p.inputs, p.single, p.numeric], [['a', 'b'], ['x', 'y'], true, true]);
  assert.deepEqual(parseBinding('confirm-before -p "kill-pane #P? (y/n)" kill-pane'), {
    kind: 'confirm',
    prompt: 'kill-pane #P? (y/n)',
    command: 'kill-pane',
    confirmKey: 'y',
    enterConfirms: false,
  });
  assert.equal(parseBinding('command-prompt -t other-client'), null);
  assert.equal(parseBinding('new-window'), null);
  assert.equal(parseBinding('command-prompt \\; new-window'), null);
  assert.equal(parseBinding(undefined), null);
});

test('fillTemplate follows tmux: first %% and every %N, %%% escapes quotes', () => {
  assert.equal(fillTemplate('rename-window "%%"', ['my win']), 'rename-window "my win"');
  assert.equal(fillTemplate('a %% b %%', ['x']), 'a x b %%');
  assert.equal(fillTemplate('a %1 %2 %1', ['x', 'y']), 'a x y x');
  assert.equal(fillTemplate('a "%%%"', ['q"$']), 'a "q\\"\\$"');
});

test('orderTabs keeps the remembered order, puts new tabs last, and remembers absent ones', () => {
  const items = ['b', 'x', 'a', 'c'].map((key) => ({ key }));
  const { tabs, order } = orderTabs(['c', 'gone', 'a', 'b'], items);
  assert.deepEqual(tabs.map((t) => t.key), ['c', 'a', 'b', 'x']);
  assert.deepEqual(order, ['c', 'gone', 'a', 'b', 'x']);
  // A window that comes back takes its old place.
  const back = orderTabs(order, ['gone', 'x', 'c'].map((key) => ({ key })));
  assert.deepEqual(back.tabs.map((t) => t.key), ['c', 'gone', 'x']);
  // Over the cap, absent keys go first, oldest first.
  const capped = orderTabs(['p', 'q', 'a', 'r'], [{ key: 'a' }, { key: 'n' }], 3);
  assert.deepEqual(capped.order, ['a', 'r', 'n']);
});

test('planSwaps puts tmux windows in tab order, using their existing indexes', () => {
  const apply = (current, swaps) => {
    const at = new Map(current.map((w) => [w.index, w.id]));
    for (const [a, b] of swaps) {
      const ia = [...at].find(([, id]) => id === a)[0];
      const ib = [...at].find(([, id]) => id === b)[0];
      at.set(ia, b);
      at.set(ib, a);
    }
    return [...at].sort((x, y) => x[0] - y[0]).map(([, id]) => id);
  };
  const current = [
    { id: '@1', index: 1 },
    { id: '@2', index: 2 },
    { id: '@5', index: 4 },
    { id: '@7', index: 9 },
  ];
  assert.deepEqual(planSwaps(current, ['@1', '@2', '@5', '@7']), []);
  for (const wanted of [['@7', '@1', '@2', '@5'], ['@5', '@7', '@2', '@1'], ['@2', '@1'], ['@9', '@7']]) {
    const swaps = planSwaps(current, wanted);
    const named = wanted.filter((id) => current.some((w) => w.id === id));
    const got = apply(current, swaps);
    assert.deepEqual(got.slice(0, named.length), named);
    assert.deepEqual(got.slice(named.length), current.map((w) => w.id).filter((id) => !named.includes(id)));
  }
});
