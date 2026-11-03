import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../server/config.js';

const bad = (text, re) => assert.throws(() => parseConfig(text, 'f.yaml'), (e) => e instanceof ConfigError && re.test(e.message));

test('empty or comment-only config gives defaults', () => {
  assert.deepEqual(parseConfig(''), { port: 7778, remotes: {} });
  assert.deepEqual(parseConfig('# nothing\n'), { port: 7778, remotes: {} });
});

test('port is read', () => {
  assert.deepEqual(parseConfig('port: 7800\n'), { port: 7800, remotes: {} });
});

test('bad port values are rejected', () => {
  bad('port: "7800"', /port: must be an integer.*got "7800"/);
  bad('port: 78.5', /port: must be an integer/);
  bad('port: 0', /port: must be an integer/);
  bad('port: 70000', /port: must be an integer/);
  bad('port:', /port: must be an integer.*got null/);
});

test('unknown keys, non-mappings, duplicates and syntax errors are rejected', () => {
  bad('prot: 7800', /unknown key "prot"/);
  bad('- 7800', /top level must be a mapping/);
  bad('7800', /top level must be a mapping/);
  bad('port: 1\nport: 2', /unique/i);
  bad('port: [1', /f\.yaml is invalid/);
});

test('every problem is listed at once', () => {
  assert.throws(() => parseConfig('port: x\nfoo: 1'), (e) => e.problems.length === 2);
});

const LUNA = `remotes:
  lunanode:
    kind: lunanode-ctl
    controller: [ssh, lunanode, lunanode-ctl]
    seed: ~/.ssh/lunanode.seed
`;

test('a remote gets its defaults, with ~ expanded', () => {
  const r = parseConfig(LUNA).remotes.lunanode;
  assert.equal(r.name, 'lunanode');
  assert.equal(r.label, 'lunanode');
  assert.deepEqual(r.controller, ['ssh', 'lunanode', 'lunanode-ctl']);
  assert.ok(!r.seed.startsWith('~') && r.seed.endsWith('/.ssh/lunanode.seed'));
  assert.equal(r.plan, 'm.1s');
  assert.equal(r.ttlSeconds, 86400);
  assert.equal(r.ipv4, true);
  assert.equal(r.user, 'ubuntu');
  assert.equal(r.identity, null);
  assert.match(r.attach, /tmux new-session -A/);
});

test('remote settings are checked strictly', () => {
  bad(LUNA + '    colour: red\n', /remotes\.lunanode: unknown key "colour"/);
  bad(LUNA + '    ttlSeconds: 10\n', /remotes\.lunanode\.ttlSeconds: must be an integer from 60/);
  bad(LUNA + '    color: blue\n', /remotes\.lunanode\.color: must be a color/);
  bad('remotes:\n  lunanode:\n    kind: lunanode-ctl\n', /"controller" is required[\s\S]*"seed" is required/);
  bad('remotes:\n  Luna_Node:\n    kind: x\n', /name must be lowercase/);
  bad('remotes: [1]', /remotes: must be a mapping/);
});
