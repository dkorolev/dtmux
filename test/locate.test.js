import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { daemonSpawn, remoteExec, repoRoot } from '../server/locate.js';

test('the checkout starts its own scripts', () => {
  assert.equal(path.basename(repoRoot()), 'dtmux');
  const [exec, args] = daemonSpawn(7778, { restarted: true });
  assert.equal(exec, process.execPath);
  assert.equal(args[0], path.join(repoRoot(), 'server', 'daemon.js'));
  assert.deepEqual(args.slice(1), ['7778', '--restarted']);
  const [, plain] = daemonSpawn(7778);
  assert.deepEqual(plain, [path.join(repoRoot(), 'server', 'daemon.js'), '7778']);
  const [bin, pre] = remoteExec();
  assert.equal(bin, process.execPath);
  assert.deepEqual(pre, [path.join(repoRoot(), 'bin', 'dtmux-remote.js')]);
});
