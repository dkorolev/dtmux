// The coding agents running in a remote tab's tmux, written down on the
// machine every minute while the tab is connected, so that a tmux that is
// killed (out of memory, `tmux kill-server`) does not take them for good.
//
// What is written is a shell script, ~/.dtmux/restore.sh, with each agent's
// directory and resume command inside it (see agent-resume.js):
//
//   sh ~/.dtmux/restore.sh report   what ran there, and why it may have ended
//   sh ~/.dtmux/restore.sh run      a new tmux session with every agent resumed
//   sh ~/.dtmux/restore.sh motd     report, but only while no tmux runs there
//
// The tab's helper (bin/dtmux-remote.js) offers `run` when it finds the tmux
// gone; a plain `ssh` login gets `motd` from a line in ~/.bashrc. A script on
// the machine, not state on this one, so it works from wherever you log in.
//
// Claude Code writes ~/.claude/sessions/<pid>.json for every running process,
// naming its session: that is resumed exactly, not just the latest session in
// the directory, which two agents in one directory would share.
import { agentOf, parsePs } from './pane-info.js';
import { resumeCommand, shellQuote } from './agent-resume.js';

// The session the default attach command makes (remote-config.js).
export const SESSION = 'dtmux';
export const RESTORE = '~/.dtmux/restore.sh';
export const BASHRC_MARK = '# dtmux: agents lost with a killed tmux';
export const BASHRC_LINE = `[ -z "$TMUX" ] && [ -f ${RESTORE} ] && sh ${RESTORE} motd  ${BASHRC_MARK}`;

// Run on the machine: its panes, its processes, Claude's session files.
// Prints `@notmux` alone when no tmux runs there, which is not "no agents".
export const GATHER = [
  "p=$(tmux list-panes -a -F '#{pane_id}\t#{window_id}\t#{pane_active}\t#{pane_tty}\t#{pane_pid}\t#{pane_current_path}' 2>/dev/null) || { echo @notmux; exit 0; }",
  'echo @panes; printf "%s\\n" "$p"',
  'echo @ps; ps -u "$(id -u)" -o pid=,pgid=,tpgid=,etime=,tty=,args=',
  'echo @claude; for f in ~/.claude/sessions/*.json; do [ -f "$f" ] && { tr -d "\\n" < "$f"; echo; }; done',
  'echo @at; date +%s',
].join('\n');

// GATHER's output -> { notmux, panes, rows, claude: Map pid -> sessionId, at }.
export function parseGather(text) {
  const out = { notmux: false, panes: [], rows: [], claude: new Map(), at: null };
  let part = null;
  const ps = [];
  for (const line of String(text).split('\n')) {
    if (line === '@notmux') out.notmux = true;
    if (/^@\w+$/.test(line)) {
      part = line.slice(1);
      continue;
    }
    if (!line.trim()) continue;
    if (part === 'panes') {
      const [id, window, active, tty, pid, ...dir] = line.split('\t');
      out.panes.push({ id, window, active: active === '1', tty, shellPid: Number(pid), dir: dir.join('\t') });
    } else if (part === 'ps') ps.push(line);
    else if (part === 'claude') {
      try {
        const s = JSON.parse(line);
        if (s?.pid && s.sessionId) out.claude.set(Number(s.pid), String(s.sessionId));
      } catch {} // a file being written as it was read
    } else if (part === 'at' && /^\d+$/.test(line.trim())) out.at = Number(line.trim());
  }
  out.rows = parsePs(ps.join('\n'));
  return out;
}

// The agents in the foreground of the panes, in pane order:
// [{ pane, window, active, dir, agent, args, command }]. `command` resumes it.
export function agentsFrom({ panes, rows, claude }) {
  const found = [];
  for (const p of panes) {
    const tty = String(p.tty).replace(/^\/dev\//, '');
    const fg = rows.filter((r) => r.tty === tty && r.tpgid > 0 && r.pgid === r.tpgid && r.pid !== p.shellPid);
    const row = fg.find((r) => agentOf(r.args));
    if (!row) continue;
    const agent = agentOf(row.args);
    const id = agent === 'Claude Code' ? claude.get(row.pid) : null;
    const command = resumeCommand(agent, row.args, id ? `claude --resume ${shellQuote(id)}` : null);
    if (!command) continue; // an agent dtmux cannot resume (Gemini, Aider, ...)
    found.push({ pane: p.id, window: p.window, active: p.active, dir: p.dir, agent, args: row.args, command });
  }
  return found;
}

// ~/.dtmux/restore.sh for these agents, as last seen running at `at` (unix
// seconds). POSIX sh: the machine may have nothing else.
export function restoreScript(agents, at) {
  const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
  const lines = agents.map((a) => `  "$1" ${q(a.dir)} ${q(a.command)} ${q(a.agent)}`);
  return `#!/bin/sh
# Written by dtmux every minute while a tab is connected to this machine: the
# coding agents that ran in its tmux, and how to resume them should that tmux
# be killed (out of memory, tmux kill-server). See server/remote-agents.js.
#   sh ${RESTORE} report | run | motd | count
AT=${Number(at) || 0}
SESSION=${SESSION}
agents() {
${lines.join('\n')}
}
show() { printf '  %s in %s\\n    %s\\n' "$3" "$1" "$2"; }
report() {
  echo "These coding agents ran in tmux here, last seen $(date -d "@$AT" 2>/dev/null || echo "at $AT"):"
  agents show
  why=$(journalctl --user --since "@$((AT - 300))" --no-pager -q 2>/dev/null | grep -i -m 3 'oom')
  if [ -n "$why" ]; then echo "The system log says, since then:"; printf '%s\\n' "$why" | sed 's/^/    /'; fi
}
first=1
open() {
  if [ $first = 1 ]; then pane=$(tmux new-session -d -s "$SESSION" -c "$1" -P -F '#{pane_id}'); first=0
  else pane=$(tmux split-window -t "$SESSION" -c "$1" -P -F '#{pane_id}'); tmux select-layout -t "$SESSION" tiled >/dev/null; fi
  # Typed into the pane's shell, as if by hand: the agent gets the shell's environment.
  tmux send-keys -t "$pane" -l "$2"
  tmux send-keys -t "$pane" Enter
}
case "\${1:-report}" in
  report) report ;;
  count) n=0; tally() { n=$((n + 1)); }; agents tally; echo $n ;;
  motd)
    tmux has-session 2>/dev/null && exit 0
    printf '\\033[1;31mThe tmux on this machine is gone: it was killed, or the machine restarted.\\033[0m\\n'
    report
    echo "Resume them all in a new tmux: sh ${RESTORE} run && tmux attach -t $SESSION"
    ;;
  run)
    if tmux has-session -t "$SESSION" 2>/dev/null; then echo "A tmux session $SESSION already runs here; not starting another." >&2; exit 1; fi
    agents open
    echo "Resumed in tmux session $SESSION:"; agents show
    ;;
  *) echo "usage: sh $0 report | run | motd | count" >&2; exit 2 ;;
esac
`;
}

// Run on the machine with the script on stdin: put it in place (or, with no
// agents, take it away) and make sure ~/.bashrc offers it on a plain login.
export function writeCommand(hasAgents) {
  if (!hasAgents) return `rm -f ${RESTORE}; cat >/dev/null`;
  return (
    `mkdir -p ~/.dtmux && cat > ${RESTORE}.new && mv -f ${RESTORE}.new ${RESTORE} && ` +
    `{ grep -qF ${shellQuote(BASHRC_MARK)} ~/.bashrc 2>/dev/null || printf '\\n%s\\n' ${shellQuote(BASHRC_LINE)} >> ~/.bashrc; }`
  );
}

// Run on the machine when the helper finds its tmux gone: the script, if
// any, is moved aside (the next snapshot would replace it) and reported.
// Prints `@file <path>` and `@count <n>` first, then the report.
export const TAKE_LOST =
  `f=${RESTORE}; if [ -f "$f" ] && ! tmux has-session 2>/dev/null; then ` +
  't=~/.dtmux/lost-$(date +%s).sh; mv "$f" "$t" && echo "@file $t" && echo "@count $(sh "$t" count)" && sh "$t" report; fi';

// TAKE_LOST's output -> { file, count, report } or null.
export function parseLost(text) {
  const m = /^@file (\S+)\n@count (\d+)\n([\s\S]*)$/.exec(String(text).replace(/^\s+/, ''));
  return m ? { file: m[1], count: Number(m[2]), report: m[3].replace(/\s+$/, '') } : null;
}
