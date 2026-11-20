import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOutput, quote } from '../server/tmux-control.js';
import { trackKitty, kittyRestoreSequence, recordKittyCommand, forgetPane } from '../server/kitty-tracker.js';
import { followTmuxOrder, macLineEdit, macWordEdit, orderTabs, parseLayout, paneBorders, tabStripDelta, tmuxKeyName, windowSwitchDirection } from '../public/tmux-util.js';
import { tokenize, parseBinding, fillTemplate } from '../server/tmux-bindings.js';
import { findResumeHint } from '../server/resume-hint.js';
import { planSwaps } from '../server/tmux-session.js';
import { parseRemote, remoteCommand } from '../server/remotes.js';
import { remoteAction } from '../server/remote-keys.js';
import { reconnectDelay } from '../server/remote-ssh.js';
import { isLocalRequest } from '../server/app.js';
import { runtimeWhy } from '../server/gh-check.js';

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

test('findResumeHint knows every shape of Claude Code 2.1 resume command', () => {
  const hint = (cmd) => findResumeHint(`\x1b[2m\nResume this session with:\n${cmd}\n\x1b[22m`)?.command;
  for (const cmd of [
    'claude --resume 41c82cc4-a5a6-4519-9b5b-b411b78cfbb9',
    'claude --resume',
    'claude --dangerously-skip-permissions --resume 41c82cc4',
    'claude --worktree "feat-x" --resume 41c82cc4',
    'claude -w "feat-x" -r 41c82cc4',
    'FOO=1 claude --resume 41c82cc4',
  ])
    assert.equal(hint(cmd), cmd);
  assert.equal(
    findResumeHint('To resume this session: cursor-agent --resume=abc-123\n')?.command,
    'cursor-agent --resume=abc-123',
  );
});

test('findResumeHint waits for the end of a command cut off between chunks', () => {
  assert.equal(findResumeHint('Resume this session with:\nclaude --res'), null);
  assert.equal(findResumeHint('Resume this session with:\nclaude --resume 41c8'), null);
  assert.equal(findResumeHint('To reconnect, run:\n  codex resume 01a1'), null);
  assert.equal(findResumeHint('Resume this session with:\nclaude --resume 41c8\n')?.command, 'claude --resume 41c8');
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

test('the mouse wheel over the tabs scrolls them sideways', () => {
  assert.equal(tabStripDelta({ deltaX: 0, deltaY: 120, deltaMode: 0 }, 400), 120);
  assert.equal(tabStripDelta({ deltaX: 0, deltaY: -40, deltaMode: 0 }, 400), -40);
  assert.equal(tabStripDelta({ deltaX: 3, deltaY: 0, deltaMode: 0 }, 400), 3, 'a sideways gesture still moves the strip');
  assert.equal(tabStripDelta({ deltaX: 2, deltaY: 5, deltaMode: 0 }, 400), 7);
  assert.equal(tabStripDelta({ deltaY: 2, deltaMode: 1 }, 400), 32, 'a notch in lines');
  assert.equal(tabStripDelta({ deltaY: 1, deltaMode: 2 }, 400), 400, 'a page is the strip width');
  assert.equal(tabStripDelta({ deltaX: 0, deltaY: 0, deltaMode: 0 }, 400), 0);
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

test('kitty tracker notes the new program when it pushes the flags already in force', () => {
  const p = '%901';
  forgetPane(p);
  trackKitty(p, Buffer.from('\x1b[>1u'));
  recordKittyCommand(p, 'zsh');
  assert.equal(trackKitty(p, Buffer.from('\x1b[>1u')), true, 'same flags, possibly another program');
  recordKittyCommand(p, 'claude');
  assert.equal(kittyRestoreSequence(p, 'claude'), '\x1b[=1;1u');
});

test('kitty state survives a hand-over to the next daemon', async () => {
  const { exportKitty, importKitty } = await import('../server/kitty-tracker.js');
  const p = '%902';
  forgetPane(p);
  trackKitty(p, Buffer.from('\x1b[>3u'));
  recordKittyCommand(p, 'claude');
  const data = JSON.parse(JSON.stringify(exportKitty()));
  forgetPane(p);
  assert.equal(kittyRestoreSequence(p, 'claude'), '');
  importKitty([...data, { id: 'bogus', cur: 1 }, { id: '%903', cur: 'x' }]);
  assert.equal(kittyRestoreSequence(p, 'claude'), '\x1b[=3;1u');
  assert.equal(kittyRestoreSequence(p, 'zsh'), '');
  assert.equal(kittyRestoreSequence('%903', 'x'), '');
});

test('pane info: etime, agents, and the foreground of a pane terminal', async () => {
  const { parseEtime, agentOf, parsePs, describePane } = await import('../server/pane-info.js');
  assert.equal(parseEtime('02:19'), 139);
  assert.equal(parseEtime('11:16:32'), 11 * 3600 + 16 * 60 + 32);
  assert.equal(parseEtime('2-03:04:05'), ((2 * 24 + 3) * 60 + 4) * 60 + 5);
  assert.equal(parseEtime('soon'), null);
  assert.equal(agentOf('claude --dangerously-skip-permissions --resume cdb1a39d'), 'Claude Code');
  assert.equal(agentOf('/Users/x/.local/share/claude/versions/2.1.317 --resume a'), 'Claude Code');
  assert.equal(agentOf('node /opt/homebrew/bin/codex resume 01a1'), 'Codex');
  assert.equal(agentOf('/Users/x/.local/share/cursor-agent/versions/2026.10/cursor-agent'), 'Cursor Agent');
  assert.equal(agentOf('vim claude.md'), null);
  assert.equal(agentOf('-zsh'), null);
  // Real `ps` rows: one pane running Claude Code (with a helper in its group),
  // one idle shell.
  const rows = parsePs(
    [
      '78394 78394 78508    45:21 ttys001  -zsh',
      '47890 78508 78508    01:44 ttys001  caffeinate -i -t 300',
      '78508 78508 78508    45:19 ttys001  claude --dangerously-skip-permissions --resume cdb1a39d',
      '78574 78508 78508    45:18 ttys001  /Applications/yab.app/Contents/MacOS/yab mcp',
      '88603 88603 88603    42:28 ttys006  -zsh',
    ].join('\n'),
  );
  const busy = describePane({ tty: '/dev/ttys001', shellPid: 78394, dir: '/tmp/x' }, rows);
  assert.equal(busy.openSecs, 45 * 60 + 21);
  assert.equal(busy.running.agent, 'Claude Code');
  assert.equal(busy.running.secs, 45 * 60 + 19);
  const idle = describePane({ tty: '/dev/ttys006', shellPid: 88603, dir: '/tmp' }, rows);
  assert.equal(idle.running, null);
  assert.equal(idle.openSecs, 42 * 60 + 28);
  const cmd = describePane(
    { tty: '/dev/ttys009', shellPid: 1 },
    parsePs('1 1 7 10:00 ttys009 -zsh\n7 7 7 00:05 ttys009 npm test'),
  );
  assert.deepEqual(cmd.running, { what: 'npm test', secs: 5, agent: null });
});

test('resumeCommand keeps the session and the launch flags, yolo included', async () => {
  const { resumeCommand, carryFlags } = await import('../server/agent-resume.js');
  const C = 'Claude Code';
  // Claude prints its own flags: nothing added twice.
  assert.equal(
    resumeCommand(C, 'claude --dangerously-skip-permissions', 'claude --dangerously-skip-permissions --resume 7e38'),
    'claude --dangerously-skip-permissions --resume 7e38',
  );
  // ... or leaves some out when the line would be too wide.
  assert.equal(
    resumeCommand(C, 'claude --dangerously-skip-permissions --model opus', 'claude --resume 7e38'),
    'claude --dangerously-skip-permissions --model opus --resume 7e38',
  );
  // No line printed: resume the session from the arguments, else continue.
  assert.equal(
    resumeCommand(C, 'claude --dangerously-skip-permissions --resume 7e38f76f', null),
    'claude --dangerously-skip-permissions --resume 7e38f76f',
  );
  assert.equal(resumeCommand(C, 'claude --permission-mode plan', null), 'claude --permission-mode plan --continue');
  // A prompt or other flags are not repeated.
  assert.equal(resumeCommand(C, 'claude --print fix the bug', 'claude --resume 1'), 'claude --resume 1');
  // Codex: flags go after `resume`; short spellings count as their long ones.
  assert.equal(
    resumeCommand('Codex', '/opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox -m gpt-5', 'codex resume 01a1'),
    'codex resume --dangerously-bypass-approvals-and-sandbox -m gpt-5 01a1',
  );
  assert.equal(resumeCommand('Codex', 'codex --yolo', null), 'codex resume --yolo --last');
  assert.equal(resumeCommand('Codex', 'codex resume 01a1 --search', null), 'codex resume --search 01a1');
  // Cursor: --yolo is --force; not added twice under two names.
  assert.equal(resumeCommand('Cursor Agent', 'cursor-agent --yolo -f', 'cursor-agent --resume=abc'), 'cursor-agent --yolo --resume=abc');
  assert.equal(resumeCommand('Cursor Agent', 'agent --force', 'agent --resume=abc'), 'agent --force --resume=abc');
  assert.equal(resumeCommand('Cursor Agent', 'cursor-agent --model=sonnet-4', null), 'cursor-agent --model sonnet-4 --continue');
  assert.equal(resumeCommand('Gemini CLI', 'gemini', null), null);
  // Values are quoted again for the shell.
  assert.deepEqual(carryFlags(C, "claude --add-dir /tmp/it's"), [{ canonical: '--add-dir', words: ['--add-dir', "/tmp/it's"] }]);
  assert.equal(resumeCommand(C, "claude --add-dir /tmp/it's", 'claude --resume 1'), `claude --add-dir '/tmp/it'\\''s' --resume 1`);
});

test('restoreBranch switches back only when nothing can be hurt', async () => {
  const { restoreBranch, branchOf } = await import('../server/git-branch.js');
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmux-branch-'));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('branch', 'feature');
  assert.equal(restoreBranch(dir, 'main'), null, 'already there');
  assert.equal(restoreBranch(dir, null), null, 'no branch saved');
  assert.match(restoreBranch(dir, 'feature', [path.join(dir, 'sub')]), /another window/);
  assert.equal(branchOf(dir), 'main');
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
  assert.match(restoreBranch(dir, 'feature'), /uncommitted changes/);
  assert.equal(branchOf(dir), 'main');
  fs.rmSync(path.join(dir, 'dirty.txt'));
  assert.match(restoreBranch(dir, 'feature'), /^Switched/);
  assert.equal(branchOf(dir), 'feature');
  assert.match(restoreBranch(dir, 'gone'), /Could not switch/);
  fs.rmSync(dir, { recursive: true });
});

test('remote window values parse, and nothing else does', () => {
  assert.deepEqual(parseRemote('lunanode/dtmux-1a2b3c4d'), { name: 'lunanode', host: 'dtmux-1a2b3c4d', address: null, upSince: null, ended: false });
  assert.deepEqual(parseRemote('lunanode/h|2602:ffb6::1|1793695053'), { name: 'lunanode', host: 'h', address: '2602:ffb6::1', upSince: 1793695053, ended: false });
  assert.equal(parseRemote('hetzner/account|ssh.dev-box.example||').address, 'ssh.dev-box.example');
  assert.deepEqual(parseRemote('lunanode/h||'), { name: 'lunanode', host: 'h', address: null, upSince: null, ended: false });
  assert.equal(parseRemote('lunanode/h|1.2.3.4;rm|x').address, null);
  assert.equal(parseRemote('lunanode/h|||ended').ended, true);
  assert.equal(parseRemote(''), null);
  assert.equal(parseRemote('lunanode'), null);
  assert.equal(parseRemote('a/b c'), null);
  assert.equal(parseRemote('a/b;rm'), null);
});

test('a remote tab runs the helper, creating only when asked', () => {
  const join = remoteCommand({ name: 'lunanode', host: 'dtmux-1a2b3c4d' });
  assert.match(join, /DTMUX_CONFIG=\S+ DTMUX_STATE_DIR=\S+ exec \S+ \S+dtmux-remote\.js lunanode dtmux-1a2b3c4d$/);
  assert.match(remoteCommand({ name: 'lunanode', host: 'h' }, { create: true }), / lunanode h --new$/);
  assert.match(remoteCommand({ name: 'lunanode', host: 'h', address: '2602:ffb6::1', upSince: 1793695053 }), / lunanode h --addr 2602:ffb6::1 --up 1793695053$/);
});

test("followTmuxOrder gives live tabs tmux's order and leaves dotted ones in place", () => {
  const windows = [
    { id: '@1', uid: 'a', index: 2 },
    { id: '@2', uid: 'b', index: 0 },
    { id: '@3', uid: 'c', index: 1 },
    { id: '@4', uid: 'new', index: 3 },
  ];
  // a, b, c are live; "saved" is a dotted tab; "new" is not in the order yet.
  assert.deepEqual(followTmuxOrder(['a', 'saved', 'b', 'c'], windows), ['b', 'saved', 'c', 'a']);
  assert.deepEqual(followTmuxOrder([], windows), []);
});

test('remoteAction: pane commands of prefix bindings', () => {
  assert.equal(remoteAction('select-pane -L'), 'left');
  assert.equal(remoteAction('select-pane -Z -D'), 'down');
  assert.equal(remoteAction('select-pane -t :.+'), 'next');
  assert.equal(remoteAction('last-pane'), 'last');
  assert.equal(remoteAction('resize-pane -Z'), 'zoom');
  assert.equal(remoteAction('kill-pane'), 'kill');
  assert.equal(remoteAction('split-window -h -c "#{pane_current_path}"'), 'splitH');
  assert.equal(remoteAction('split-window'), 'splitV');
  assert.equal(remoteAction('resize-pane -L 5'), null);
  assert.equal(remoteAction('confirm-before -p "kill-pane #P? (y/n)" kill-pane'), null); // asked first, then kill-pane
  assert.equal(remoteAction('select-pane -L ; display-message hi'), null);
  assert.equal(remoteAction('new-window'), null);
  assert.equal(remoteAction(undefined), null);
});

test('reconnectDelay spreads tries at random and backs off to at most 30s', () => {
  // rand 1 (never drawn) stands for the top of the range.
  assert.equal(reconnectDelay(1, 0), 3000);
  assert.equal(reconnectDelay(1, 1), 5000);
  assert.equal(reconnectDelay(2, 0), 6000);
  assert.equal(reconnectDelay(3, 0), 12000);
  assert.equal(reconnectDelay(4, 0), 18000);
  assert.equal(reconnectDelay(50, 1), 30000);
});

test('isLocalRequest accepts only loopback sockets, local Host headers, and matching local Origins', () => {
  const req = (remoteAddress, host, origin) => ({
    socket: { remoteAddress },
    headers: { ...(host !== undefined ? { host } : {}), ...(origin !== undefined ? { origin } : {}) },
  });
  // HTTP requests from this machine (browser or CLI health probe).
  assert.equal(isLocalRequest(req('127.0.0.1', '127.0.0.1:7778')), true);
  assert.equal(isLocalRequest(req('::1', 'localhost:7778', 'http://localhost:7778')), true);
  assert.equal(isLocalRequest(req('::ffff:127.0.0.1', '[::1]:7778', 'http://[::1]:7778')), true);
  // Non-loopback sockets are refused.
  assert.equal(isLocalRequest(req('192.168.1.10', '127.0.0.1:7778', 'http://127.0.0.1:7778')), false);
  assert.equal(isLocalRequest(req(undefined, '127.0.0.1:7778', 'http://127.0.0.1:7778')), false);
  // DNS rebinding (Host + Origin both set to an external domain resolving to 127.0.0.1) is refused.
  assert.equal(isLocalRequest(req('127.0.0.1', 'evil.example.com:7778', 'http://evil.example.com:7778')), false);
  assert.equal(isLocalRequest(req('127.0.0.1', undefined)), false);
  // WebSocket handshakes require a matching local Origin.
  assert.equal(isLocalRequest(req('127.0.0.1', '127.0.0.1:7778', 'http://127.0.0.1:7778'), { requireOrigin: true }), true);
  assert.equal(isLocalRequest(req('127.0.0.1', '127.0.0.1:7778'), { requireOrigin: true }), false);
  assert.equal(isLocalRequest(req('127.0.0.1', '127.0.0.1:7778', 'null'), { requireOrigin: true }), false);
  assert.equal(isLocalRequest(req('127.0.0.1', '127.0.0.1:7778', 'https://evil.example.com'), { requireOrigin: true }), false);
  assert.equal(isLocalRequest(req('127.0.0.1', '127.0.0.1:7778', 'http://localhost:7778'), { requireOrigin: true }), false);
  assert.equal(isLocalRequest(req('127.0.0.1', '127.0.0.1:7778', 'file://'), { requireOrigin: true }), false);
});

test('a container runtime that is missing or idle is said in one short phrase', () => {
  assert.equal(runtimeWhy(127, '', ''), 'not installed');
  assert.equal(
    runtimeWhy(1, 'Error: unable to connect to Podman socket: failed to read identity "/Users/dima/.local/share/containers/podman/machine/machine"', ''),
    'not running',
  );
  assert.equal(runtimeWhy(1, '', ''), 'exit 1');
});
