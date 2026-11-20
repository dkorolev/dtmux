import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueDeleteCode, takeDeleteCode, DELETE_CODE_TTL_MS } from '../server/delete-codes.js';

test('a code is four digits and confirms its delete once', () => {
  const code = issueDeleteCode('w:@1', 0);
  assert.match(code, /^\d{4}$/);
  assert.equal(takeDeleteCode('w:@1', code, 1), true);
  assert.equal(takeDeleteCode('w:@1', code, 2), false, 'a code is used once');
});

test('a wrong guess uses up the code', () => {
  const code = issueDeleteCode('saved:a', 0);
  const wrong = code === '0000' ? '0001' : '0000';
  assert.equal(takeDeleteCode('saved:a', wrong, 1), false);
  assert.equal(takeDeleteCode('saved:a', code, 2), false, 'the right code no longer works after a wrong one');
});

test('a code is for its own tab only', () => {
  const code = issueDeleteCode('w:@2', 0);
  assert.equal(takeDeleteCode('w:@3', code, 1), false);
  assert.equal(takeDeleteCode('w:@2', code, 1), true, 'the tab it was issued for still has it');
});

test('a code expires', () => {
  const code = issueDeleteCode('w:@4', 0);
  assert.equal(takeDeleteCode('w:@4', code, DELETE_CODE_TTL_MS), false, 'at the limit it is already too late');
});

test('no code issued means no delete', () => {
  assert.equal(takeDeleteCode('w:@9', '1234', 0), false);
  assert.equal(takeDeleteCode('w:@9', undefined, 0), false);
});

test('a new request replaces the earlier code for the tab', () => {
  issueDeleteCode('w:@5', 0);
  const second = issueDeleteCode('w:@5', 0);
  assert.equal(takeDeleteCode('w:@5', second, 1), true);
});
