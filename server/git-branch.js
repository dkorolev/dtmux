// The git branch a saved window was on, and putting it back on reopen.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The branch checked out in `dir`, or null (not a checkout, detached HEAD).
export function branchOf(dir) {
  try {
    const b = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}

// `d` with symlinks resolved (/var is /private/var on macOS), even when its
// last parts no longer exist.
function real(d) {
  let head = path.resolve(d);
  let rest = '';
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), rest);
    } catch {
      const up = path.dirname(head);
      if (up === head) return path.resolve(d);
      rest = path.join(path.basename(head), rest);
      head = up;
    }
  }
}

function toplevel(dir) {
  try {
    return fs.realpathSync(git(dir, 'rev-parse', '--show-toplevel'));
  } catch {
    return null;
  }
}

// Put `dir` back on `branch` before a window reopens there. Only when that
// cannot hurt: the checkout has no uncommitted changes and no other open
// pane works in it (`openDirs`), since switching changes the branch under
// them too. Returns a sentence for the page, or null when nothing was to do.
export function restoreBranch(dir, branch, openDirs = []) {
  if (!branch) return null;
  const now = branchOf(dir);
  if (!now || now === branch) return null;
  const top = toplevel(dir);

  if (top && openDirs.some((d) => d && (real(d) === top || real(d).startsWith(top + path.sep))))
    return `${dir} is on ${now}, not ${branch}: another window works in that checkout, so it was left as is.`;
  try {
    if (git(dir, 'status', '--porcelain')) return `${dir} is on ${now}, not ${branch}: it has uncommitted changes, so it was left as is.`;
    git(dir, 'switch', branch);
    return `Switched ${dir} back to ${branch} (it was on ${now}).`;
  } catch (err) {
    const why = String(err.stderr || err.message).trim().split('\n')[0];
    return `Could not switch ${dir} back to ${branch}: ${why}`;
  }
}
