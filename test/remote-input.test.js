import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paneInputCommand } from '../server/tmux-session.js';

test('watcher accepts a pasted SSH attach command or target shorthand', async () => {
  const { parseWatchInput } = await import('../server/tmux-watch.js');
  const target = { host: 'dima.personal', session: 'scrape-lane1' };
  for (const input of [
    "ssh -t dima.personal 'tmux attach -r -t scrape-lane1'",
    'ssh -tt dima.personal "tmux attach-session -rt =scrape-lane1"',
    'ssh dima.personal tmux a -t scrape-lane1 -r',
    'dima.personal/scrape-lane1',
    'dima.personal scrape-lane1',
  ]) assert.deepEqual(parseWatchInput(input), target);
  for (const input of [
    "ssh -t dima.personal 'tmux attach -t scrape-lane1; id'",
    "ssh -t dima.personal 'tmux attach -d -t scrape-lane1'",
    "ssh -t dima.personal 'tmux attach -t $(id)'",
    "ssh -t dima.personal 'tmux attach -t scrape-lane1 -t other'",
    'dima.personal',
  ]) assert.equal(parseWatchInput(input), null);
});

test('a refused watcher input is explained in plain, pasteable text', async () => {
  const { watchInputProblem } = await import('../server/tmux-watch.js');
  const input = "ssh -t dima2.personal '~/bench/watch.sh ~/bench/out'";
  const text = watchInputProblem(input);
  assert.match(text, /^dtmux \(a tmux web UI\) can watch/);
  assert.ok(text.includes(`\n  ${input}\n`));
  assert.match(text, /does not run other remote commands/);
  assert.match(text, /please provide a single-line command in exactly this form:\n\n  ssh -t HOST 'tmux attach -r -t SESSION'\n/);
  assert.match(watchInputProblem("ssh -t h 'tmux attach -t x; id'"), /tmux attach is not one dtmux accepts/);
  assert.match(watchInputProblem('ssh h'), /no remote part/);
});

test('connecting remotes drop interrupts and read-only watchers drop all input', {
  skip: spawnSync('tmux', ['-V']).status !== 0,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmux-input-'));
  const socket = path.join(dir, 'tmux');
  const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' }).trim();
  const helper = fileURLToPath(new URL('../bin/dtmux-remote.js', import.meta.url));
  const waitFor = async (check) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail('Timed out waiting for the remote helper: ' + tmux('capture-pane', '-p'));
  };
  try {
    fs.writeFileSync(path.join(dir, 'config'), 'remotes:\n  box:\n    kind: devbox-ctl\n    controller: [false-command]\n    address: example.invalid\n');
    fs.writeFileSync(path.join(dir, 'ssh'), `#!/bin/sh
if [ "$1" != "-t" ]; then echo 1234567890; exit; fi
stty raw -echo
touch "$FIXTURE/joining"
while [ ! -e "$FIXTURE/draw" ]; do sleep 0.05; done
printf 'remote screen'
exec cat > "$FIXTURE/input"
`, { mode: 0o700 });
    const pane = tmux('-f', '/dev/null', 'new-session', '-d', '-P', '-F', '#{pane_id}', 'env',
      `PATH=${dir}:${process.env.PATH}`, `FIXTURE=${dir}`, `DTMUX_CONFIG=${dir}/config`, `DTMUX_STATE_DIR=${dir}`,
      process.execPath, helper, 'box', 'fixture', '--addr', 'example.invalid');
    const press = (byte) => execFileSync('tmux', ['-S', socket, 'source-file', '-'], {
      input: paneInputCommand(pane, Buffer.from([byte])) + '\n',
    });
    await waitFor(() => fs.existsSync(path.join(dir, 'joining')));
    assert.equal(tmux('display', '-p', '-t', pane, '#{@dtmux_connecting}'), '1');
    press(3);
    press(4);
    fs.writeFileSync(path.join(dir, 'draw'), '');
    await waitFor(() => tmux('display', '-p', '-t', pane, '#{@dtmux_connecting}') === '0');
    press(3);
    press(4);
    await waitFor(() => fs.statSync(path.join(dir, 'input')).size >= 2);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'input')), Buffer.from([3, 4]));

    tmux('set-option', '-w', '-t', pane, '@dtmux_watch', 'example.invalid/observed');
    press(3);
    press(4);
    press(65);
    tmux('set-option', '-wu', '-t', pane, '@dtmux_watch');
    press(66);
    await waitFor(() => fs.readFileSync(path.join(dir, 'input')).includes(66));
    assert.deepEqual(fs.readFileSync(path.join(dir, 'input')), Buffer.from([3, 4, 66]));
  } finally {
    spawnSync('tmux', ['-S', socket, 'kill-server']);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
