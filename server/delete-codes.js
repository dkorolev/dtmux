// The four digits that confirm deleting a remote tab's machine.
//
// Deleting a machine cannot be undone, so the daemon, not just the page,
// insists on the digits: a delete request for a remote tab gets a code here,
// shown in the page's dialog, and the delete is carried out only with that
// code, once, within a minute. A wrong guess uses up the code.
//
// Keys name the tab: `w:<tmux window id>` for a live window, `saved:<id>` for
// a dotted one.
import { randomInt } from 'node:crypto';

export const DELETE_CODE_TTL_MS = 60000;

const pending = new Map(); // key -> { code, until }

// A new code for `key`, replacing any earlier one for it.
export function issueDeleteCode(key, now = Date.now()) {
  const code = String(randomInt(10000)).padStart(4, '0');
  pending.set(key, { code, until: now + DELETE_CODE_TTL_MS });
  return code;
}

// True when `code` is the code issued for `key` and still in time. The code
// is forgotten either way: a second try needs a new code.
export function takeDeleteCode(key, code, now = Date.now()) {
  const entry = pending.get(key);
  pending.delete(key);
  return Boolean(entry && entry.until > now && entry.code === String(code));
}
