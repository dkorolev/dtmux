import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paneInputCommand } from '../server/tmux-session.js';

test('connection-time interrupts are dropped and both keys reach the attached terminal', {
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
  } finally {
    spawnSync('tmux', ['-S', socket, 'kill-server']);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
