// What is open, written down every little while, for when dtmux cannot write
// it down at the end: a crash, power loss, or a reboot where tmux is gone
// before the daemon can list its windows (at shutdown everything gets
// SIGTERM at once). The next start then offers those windows as dotted tabs,
// as a gentle stop would have.
//
// ~/.dtmux/live-windows.json: { version: 1, at, tmuxPid, live: [ saveOnStop items ] }
// A clean full stop removes it; a soft restart leaves it (tmux runs on).
// Coding agents cannot be asked for their resume line here (that means
// closing them), so their resume command comes from their command line
// alone (see agent-resume.js): their latest session, same flags.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { TMUX_BIN, tmuxArgs } from './tmux-control.js';
import { STATE_DIR } from './paths.js';
import { ID_OPTION } from './saved-windows.js';
import { sessionPanes } from './pane-info.js';
import { resumeCommand } from './agent-resume.js';
import { branchOf } from './git-branch.js';
import { REMOTE_FORMAT, parseRemote } from './remotes.js';

export const SNAPSHOT_FILE = path.join(STATE_DIR, 'live-windows.json');

export const LIVE_FORMAT = [
  '#{session_name}',
  '#{window_index}',
  `#{${ID_OPTION}}`,
  '#{automatic-rename}',
  '#{window_id}',
  '#{pane_current_path}',
  REMOTE_FORMAT,
  '#{window_name}',
].join('\t');

// `list-windows -a -F LIVE_FORMAT` output -> saveOnStop items. `agents`:
// window id -> { dir, agent, command }, the agent to resume there.
export function parseLive(out, agents = new Map()) {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [session, index, id, auto, windowId, paneDir, remote, ...name] = line.split('\t');
      const agent = agents.get(windowId);
      const where = parseRemote(remote);
      const dir = agent?.dir || paneDir;
      return {
        session,
        index: Number(index),
        id,
        autoName: auto === '1',
        dir,
        branch: where ? null : branchOf(dir),
        agent: agent?.command ? { name: agent.agent, command: agent.command } : null,
        remote: where,
        name: name.join('\t'),
      };
    });
}

const run = (...args) =>
  new Promise((resolve) => execFile(TMUX_BIN, tmuxArgs(...args), { timeout: 5000 }, (err, out) => resolve(err ? null : out)));

// The agents running now, from `ps`, per window: the active pane's wins.
async function runningAgents(sessions) {
  const agents = new Map();
  for (const s of sessions) {
    const panes = await new Promise((resolve) => sessionPanes(TMUX_BIN, tmuxArgs, s, (err, list) => resolve(err ? [] : list)));
    for (const p of panes) {
      if (!p.running?.agent) continue;
      const command = resumeCommand(p.running.agent, p.running.args, null);
      if (command && (!agents.has(p.window) || p.active)) agents.set(p.window, { dir: p.path, agent: p.running.agent, command });
    }
  }
  return agents;
}

// Write the snapshot now. Resolves to the number of windows, or null when
// tmux is not running (the file is then left as it was).
export async function writeSnapshot() {
  const pid = (await run('display', '-p', '#{pid}'))?.trim();
  const sessions = (await run('list-sessions', '-F', '#{session_name}'))?.split('\n').filter(Boolean);
  if (!pid || !sessions) return null;
  const out = await run('list-windows', '-a', '-F', LIVE_FORMAT);
  if (out === null) return null;
  const live = parseLive(out, await runningAgents(sessions));
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${SNAPSHOT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, at: new Date().toISOString(), tmuxPid: pid, live }, null, 2) + '\n');
  fs.renameSync(tmp, SNAPSHOT_FILE);
  return live.length;
}

export function readSnapshot() {
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    return data?.version === 1 && Array.isArray(data.live) ? data : null;
  } catch {
    return null;
  }
}

export function dropSnapshot() {
  try {
    fs.unlinkSync(SNAPSHOT_FILE);
  } catch {}
}
