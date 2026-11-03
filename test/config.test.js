import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../server/config.js';

const bad = (text, re) => assert.throws(() => parseConfig(text, 'f.yaml'), (e) => e instanceof ConfigError && re.test(e.message));

test('empty or comment-only config gives defaults', () => {
  assert.deepEqual(parseConfig(''), { port: 7778 });
  assert.deepEqual(parseConfig('# nothing\n'), { port: 7778 });
});

test('port is read', () => {
  assert.deepEqual(parseConfig('port: 7800\n'), { port: 7800 });
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
