// What a tab's tooltip says about its window: for each pane, the directory,
// how long the pane has been open, and what runs in its foreground, with
// coding agents (Claude Code, Codex, ...) named as such.
//
// tmux knows each pane's directory, terminal and shell. The rest comes from
// `ps` over the pane's terminal: the foreground process group is the one the
// terminal's tpgid names, and `etime` says how long each process has run.
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Ordered: the first match names the agent. Matched against each argument's
// basename, so `node /…/bin/codex` and `/…/claude/versions/2.1.317` count.
const AGENTS = [
  ['Claude Code', (a) => a.some((x) => x === 'claude' || /\/claude\/versions\/[\d.]+$/.test(x))],
  ['Codex', (a) => a.some((x) => x === 'codex' || x.endsWith('/codex'))],
  ['Cursor Agent', (a) => a.some((x) => x === 'cursor-agent' || x.includes('/cursor-agent/'))],
  ['Gemini CLI', (a) => a.some((x) => x === 'gemini' || x.endsWith('/gemini'))],
  ['Aider', (a) => a.some((x) => x === 'aider' || x.endsWith('/aider'))],
  ['opencode', (a) => a.some((x) => x === 'opencode' || x.endsWith('/opencode'))],
];

// "[[dd-]hh:]mm:ss" from ps, in seconds; null if it is not that.
export function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return null;
  const [, d = 0, h = 0, min, sec] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec);
}

// The agent an argument list belongs to, or null.
export function agentOf(args) {
  const words = String(args).split(/\s+/).filter(Boolean).slice(0, 3);
  const names = words.flatMap((w) => [w, path.basename(w)]);
  for (const [name, test] of AGENTS) if (test(names)) return name;
  return null;
}

// `ps -A -o pid=,pgid=,tpgid=,etime=,tty=,args=` output, as rows.
export function parsePs(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), pgid: Number(m[2]), tpgid: Number(m[3]), secs: parseEtime(m[4]), tty: m[5], args: m[6] });
  }
  return rows;
}

// One pane, from its tmux fields and the ps rows of its terminal:
// { dir, openSecs, running: { what, secs, agent } | null }. `running` is
// null while the shell itself is in the foreground.
export function describePane({ tty, shellPid, dir }, rows) {
  const name = String(tty).replace(/^\/dev\//, '');
  const mine = rows.filter((r) => r.tty === name);
  const shell = mine.find((r) => r.pid === shellPid);
  const fg = mine.filter((r) => r.tpgid > 0 && r.pgid === r.tpgid && r.pid !== shellPid);
  let running = null;
  if (fg.length) {
    // The group's leader, else its oldest member.
    const lead = fg.find((r) => r.pid === r.pgid) ?? [...fg].sort((a, b) => (b.secs ?? 0) - (a.secs ?? 0))[0];
    const agentRow = fg.find((r) => agentOf(r.args)) ?? null;
    running = {
      what: lead.args.length > 80 ? `${lead.args.slice(0, 79)}…` : lead.args,
      secs: (agentRow ?? lead).secs,
      agent: agentRow ? agentOf(agentRow.args) : null,
    };
    // Not for the page: the agent's whole command line, for resuming it.
    if (agentRow) Object.defineProperty(running, 'args', { value: agentRow.args, enumerable: false });
  }
  return { dir: tildify(dir), openSecs: shell?.secs ?? null, running };
}

export function tildify(dir) {
  const home = os.homedir();
  if (!dir) return '';
  if (dir === home) return '~';
  return dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}

// Every pane of a session (or one window: `target` "@3"), with what runs in
// it, through the tmux command line: for when no control client is at hand.
// cb(err, [{ id, window, active, tty, dir, ...describePane }]).
export function sessionPanes(tmuxBin, tmuxArgs, target, cb) {
  const format = ['#{pane_id}', '#{window_id}', '#{pane_active}', '#{pane_tty}', '#{pane_pid}', '#{pane_current_path}'].join('\t');
  const scope = target.startsWith('@') ? ['-t', target] : ['-s', '-t', `=${target}`];
  execFile(tmuxBin, tmuxArgs('list-panes', ...scope, '-F', format), (err, out) => {
    if (err) return cb(err);
    const panes = out.split('\n').filter(Boolean).map((l) => {
      const [id, window, active, tty, pid, ...dir] = l.split('\t');
      return { id, window, active: active === '1', tty, shellPid: Number(pid), dir: dir.join('\t') };
    });
    execFile('ps', ['-A', '-o', 'pid=,pgid=,tpgid=,etime=,tty=,args='], { maxBuffer: 16 << 20, timeout: 3000 }, (psErr, psOut) => {
      const rows = psErr ? [] : parsePs(psOut);
      cb(null, panes.map((p) => ({ ...p, ...describePane(p, rows), path: p.dir })));
    });
  });
}

// All panes of a window, in tmux's pane order. `tmux` is a TmuxControl.
export function windowInfo(tmux, windowId, cb) {
  const format = ['#{pane_id}', '#{pane_active}', '#{pane_tty}', '#{pane_pid}', '#{pane_current_path}'].join('\t');
  tmux.run(`list-panes -t ${windowId} -F "${format}"`, (err, lines) => {
    if (err) return cb(err);
    const panes = lines.filter(Boolean).map((l) => {
      const [id, active, tty, pid, ...dir] = l.split('\t');
      return { id, active: active === '1', tty, shellPid: Number(pid), dir: dir.join('\t') };
    });
    execFile('ps', ['-A', '-o', 'pid=,pgid=,tpgid=,etime=,tty=,args='], { maxBuffer: 16 << 20, timeout: 3000 }, (psErr, out) => {
      const rows = psErr ? [] : parsePs(out);
      cb(null, panes.map((p) => ({ id: p.id, active: p.active, ...describePane(p, rows) })));
    });
  });
}
