// Every pane of a window, written down so the window comes back whole: a
// Disconnect or a stop saves each pane's directory, git branch and coding
// agent, and the window's layout; reopening splits the window again, puts
// the layout back and resumes each pane's agent (tmux-session.js).
//
// A saved entry of a window with more than one pane gets
//   panes: [ { dir, branch?, agent? }, ... ]  in tmux's pane order
//   layout: '#{window_layout}'                 tmux's own layout string
//   activePane: the index of the pane that was active
// and keeps `dir` / `agent` of its active pane, as for a one-pane window.
// A remote tab's window has one pane here (its panes live on the machine).
import { execFile } from 'node:child_process';
import { branchOf } from './git-branch.js';

export const PANES_FORMAT = ['#{window_id}', '#{window_layout}', '#{pane_id}', '#{pane_active}', '#{pane_current_path}'].join('\t');

// `list-panes -F PANES_FORMAT` output -> Map window id -> { layout, panes: [{ id, active, dir }] }.
export function parsePanes(out) {
  const windows = new Map();
  for (const line of String(out ?? '').split('\n')) {
    if (!line) continue;
    const [window, layout, id, active, ...dir] = line.split('\t');
    if (!windows.has(window)) windows.set(window, { layout, panes: [] });
    windows.get(window).panes.push({ id, active: active === '1', dir: dir.join('\t') });
  }
  return windows;
}

// The panes of every window (`target` null), or of one window ("@3").
export function listPanes(tmuxBin, tmuxArgs, target = null) {
  const scope = target ? ['-t', target] : ['-a'];
  return new Promise((resolve) =>
    execFile(tmuxBin, tmuxArgs('list-panes', ...scope, '-F', PANES_FORMAT), { timeout: 5000 }, (err, out) => resolve(err ? new Map() : parsePanes(out))),
  );
}

// The agent to resume in each pane: pane id -> { dir, agent, command }.
// `found`: closeAgents' (or the snapshot's) list.
export const agentsByPane = (found) => new Map(found.filter((a) => a.command).map((a) => [a.pane, a]));

// What a saved entry keeps of a window's panes: { panes, layout, activePane }
// for more than one pane, else {}. `agents`: from agentsByPane.
export function panesOf(win, agents = new Map()) {
  if (!win || win.panes.length < 2) return {};
  const panes = win.panes.map((p) => {
    const a = agents.get(p.id);
    const dir = a?.dir || p.dir;
    const out = { dir };
    const branch = branchOf(dir);
    if (branch) out.branch = branch;
    if (a?.command) out.agent = { name: a.agent, command: a.command };
    return out;
  });
  return { panes, layout: win.layout, activePane: Math.max(0, win.panes.findIndex((p) => p.active)) };
}

// The agent of a window as a whole: its active pane's, else any pane's.
export function windowAgent(win, agents) {
  const ids = win?.panes.map((p) => p.id) ?? [];
  const here = ids.map((id) => agents.get(id)).filter(Boolean);
  return here.find((a) => a.active) ?? here[0] ?? null;
}
