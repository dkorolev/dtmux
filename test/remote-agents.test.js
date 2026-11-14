import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BASHRC_MARK,
  TAKE_LOST,
  agentsFrom,
  parseGather,
  parseLost,
  restoreScript,
  writeCommand,
} from '../server/remote-agents.js';

const GATHERED = [
  '@panes',
  '%0\t@0\t1\t/dev/pts/3\t100\t/home/u/research',
  '%1\t@0\t0\t/dev/pts/4\t200\t/home/u/code',
  '%2\t@0\t0\t/dev/pts/5\t300\t/home/u',
  '%3\t@0\t0\t/dev/pts/6\t400\t/home/u/notes',
  '@ps',
  '  100   100   110    01:00:00 pts/3    -bash',
  '  110   110   110    00:59:00 pts/3    claude --dangerously-skip-permissions --model opus',
  '  200   200   210    00:30:00 pts/4    -bash',
  '  210   210   210    00:29:00 pts/4    node /usr/lib/node_modules/@openai/codex/bin/codex --yolo',
  '  300   300   300    00:10:00 pts/5    -bash',
  '  400   400   410    00:05:00 pts/6    -bash',
  '  410   410   410    00:04:00 pts/6    claude',
  '  500   500    -1    02:00:00 ?        claude --print hi',
  '@claude',
  '{"pid":110,"sessionId":"bde447be-7321-4d30-b1ea-02e71f3807de","cwd":"/home/u/research"}',
  '{"pid":999,"sessionId":"not-a-pane"}',
  '{"pid": 1, broken',
  '@at',
  '1794614111',
].join('\n');

test('parseGather reads panes, processes, Claude session files and the time', () => {
  const g = parseGather(GATHERED);
  assert.equal(g.notmux, false);
  assert.equal(g.panes.length, 4);
  assert.deepEqual(g.panes[0], { id: '%0', window: '@0', active: true, tty: '/dev/pts/3', shellPid: 100, dir: '/home/u/research' });
  assert.equal(g.rows.length, 8);
  assert.equal(g.claude.get(110), 'bde447be-7321-4d30-b1ea-02e71f3807de');
  assert.equal(g.claude.size, 2); // the broken file is skipped
  assert.equal(g.at, 1794614111);
});

test('parseGather tells "no tmux" apart from "no agents"', () => {
  assert.equal(parseGather('@notmux\n').notmux, true);
  const empty = parseGather('@panes\n%0\t@0\t1\t/dev/pts/1\t1\t/home/u\n@ps\n    1     1     1 00:01 pts/1 -bash\n@claude\n@at\n5\n');
  assert.equal(empty.notmux, false);
  assert.deepEqual(agentsFrom(empty), []);
});

test('agentsFrom resumes Claude by its exact session, others by their latest, with their flags', () => {
  const found = agentsFrom(parseGather(GATHERED));
  assert.deepEqual(
    found.map((a) => [a.pane, a.agent, a.dir, a.command]),
    [
      ['%0', 'Claude Code', '/home/u/research', 'claude --dangerously-skip-permissions --model opus --resume bde447be-7321-4d30-b1ea-02e71f3807de'],
      ['%1', 'Codex', '/home/u/code', 'codex resume --yolo --last'],
      // No session file for this one (it may not have written it yet): the latest in its directory.
      ['%3', 'Claude Code', '/home/u/notes', 'claude --continue'],
    ],
  );
});

test('parseLost reads what TAKE_LOST prints', () => {
  assert.equal(parseLost(''), null);
  assert.deepEqual(parseLost('@file /home/u/.dtmux/lost-5.sh\n@count 2\nThese ran:\n  a\n\n'), {
    file: '/home/u/.dtmux/lost-5.sh',
    count: 2,
    report: 'These ran:\n  a',
  });
});

// A fake tmux on PATH, logging every call; `has-session` answers as told.
function sandbox({ hasSession = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmux-agents-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(home, 'tmux.log');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$1" in
  has-session) exit ${hasSession ? 0 : 1} ;;
  new-session) echo '%10' ;;
  split-window) echo '%11' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const sh = (args, input = '') => spawnSync('sh', args, { env, cwd: home, input, encoding: 'utf8' });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { home, sh, calls };
}

const AGENTS = [
  { dir: '/home/u/research', command: 'claude --dangerously-skip-permissions --resume abc', agent: 'Claude Code' },
  { dir: "/home/u/it's here", command: 'codex resume --yolo --last', agent: 'Codex' },
];

test('restore.sh run starts a session, one pane per agent, and types each resume command', () => {
  const { home, sh, calls } = sandbox();
  const file = path.join(home, 'restore.sh');
  fs.writeFileSync(file, restoreScript(AGENTS, 1794614111));
  assert.equal(sh([file, 'count']).stdout.trim(), '2');
  const r = sh([file, 'run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(), [
    'has-session -t dtmux',
    "new-session -d -s dtmux -c /home/u/research -P -F #{pane_id}",
    'send-keys -t %10 -l claude --dangerously-skip-permissions --resume abc',
    'send-keys -t %10 Enter',
    "split-window -t dtmux -c /home/u/it's here -P -F #{pane_id}",
    'select-layout -t dtmux tiled',
    'send-keys -t %11 -l codex resume --yolo --last',
    'send-keys -t %11 Enter',
  ]);
  assert.match(r.stdout, /Resumed in tmux session dtmux/);
});

test('restore.sh run will not start a second session, and motd stays quiet while tmux runs', () => {
  const { home, sh, calls } = sandbox({ hasSession: true });
  const file = path.join(home, 'restore.sh');
  fs.writeFileSync(file, restoreScript(AGENTS, 1794614111));
  const r = sh([file, 'run']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already runs/);
  assert.equal(calls().filter((c) => !c.startsWith('has-session')).length, 0);
  assert.equal(sh([file, 'motd']).stdout, '');
});

test('restore.sh motd and report list the agents when no tmux runs', () => {
  const { home, sh } = sandbox();
  const file = path.join(home, 'restore.sh');
  fs.writeFileSync(file, restoreScript(AGENTS, 1794614111));
  const motd = sh([file, 'motd']).stdout;
  assert.match(motd, /tmux on this machine is gone/);
  assert.match(motd, /Claude Code in \/home\/u\/research\n {4}claude --dangerously-skip-permissions --resume abc/);
  assert.match(motd, /Codex in \/home\/u\/it's here/);
  assert.match(motd, /restore\.sh run && tmux attach -t dtmux/);
  assert.match(sh([file, 'report']).stdout, /These coding agents ran in tmux here/);
});

test('writeCommand puts the script in place, adds the login line once, and clears it with no agents', () => {
  const { home, sh } = sandbox();
  const script = restoreScript(AGENTS, 1);
  for (let i = 0; i < 2; i++) assert.equal(sh(['-c', writeCommand(true)], script).status, 0);
  assert.equal(fs.readFileSync(path.join(home, '.dtmux/restore.sh'), 'utf8'), script);
  const bashrc = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
  assert.equal(bashrc.split(BASHRC_MARK).length - 1, 1);
  assert.match(bashrc, /\[ -z "\$TMUX" \] && \[ -f ~\/\.dtmux\/restore\.sh \] && sh ~\/\.dtmux\/restore\.sh motd/);
  assert.equal(sh(['-c', writeCommand(false)], script).status, 0);
  assert.equal(fs.existsSync(path.join(home, '.dtmux/restore.sh')), false);
});

test('TAKE_LOST moves the script aside and reports it only when no tmux runs', () => {
  const alive = sandbox({ hasSession: true });
  alive.sh(['-c', writeCommand(true)], restoreScript(AGENTS, 1));
  assert.equal(alive.sh(['-c', TAKE_LOST]).stdout, '');
  assert.equal(fs.existsSync(path.join(alive.home, '.dtmux/restore.sh')), true);

  const gone = sandbox();
  gone.sh(['-c', writeCommand(true)], restoreScript(AGENTS, 1));
  const lost = parseLost(gone.sh(['-c', TAKE_LOST]).stdout);
  assert.equal(lost.count, 2);
  assert.match(lost.file, /\/\.dtmux\/lost-\d+\.sh$/);
  assert.match(lost.report, /codex resume --yolo --last/);
  assert.equal(fs.existsSync(path.join(gone.home, '.dtmux/restore.sh')), false);
  assert.equal(fs.existsSync(lost.file), true);
});
