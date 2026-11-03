// Close the coding agents in a session (or one window) the way a person
// would, and learn how to bring each one back.
//
// Each agent gets Ctrl+C until it leaves (the first one may only clear its
// input or stop its turn). As it leaves it prints its resume line, read here
// from the pane's live output through a control client of our own, so only
// what it prints now counts, never an older line in the scrollback. With the
// agent's launch flags (see agent-resume.js) that makes the resume command.
// Agents that do not leave in time are left to whatever ends their pane.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { TmuxControl, TMUX_BIN, tmuxArgs } from './tmux-control.js';
import { sessionPanes } from './pane-info.js';
import { findResumeHint } from './resume-hint.js';
import { resumeCommand } from './agent-resume.js';

const TIMEOUT_MS = 5000;
const POLL_MS = 250;
const CTRL_C_AT_MS = [0, 300, 1500, 3000]; // while the agent is still there

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args) =>
  new Promise((resolve) =>
    execFile(TMUX_BIN, tmuxArgs(...args), { timeout: 3000 }, (err, out) => resolve(err ? null : out.trim())),
  );
const panesOf = (session, target) =>
  new Promise((resolve) => sessionPanes(TMUX_BIN, tmuxArgs, target ?? session, (err, list) => resolve(err ? [] : list)));

// Resolves to [{ pane, window, active, dir, agent, command }], one per agent
// found, `command` being how to resume it (null for an agent dtmux cannot
// resume yet). `target`: a window id ("@3") to close only that window's agents.
export async function closeAgents(session, { target = null, log = () => {} } = {}) {
  const agents = (await panesOf(session, target)).filter((p) => p.running?.agent);
  if (!agents.length) return [];
  const size = (await tmux('display', '-p', '-t', `=${session}:`, '#{window_width}\t#{window_height}')) ?? '';
  const [cols, rows] = size.split('\t').map(Number);
  const out = new Map(agents.map((a) => [a.id, '']));
  const hints = new Map();
  const control = new TmuxControl({ session, cols: cols || 200, rows: rows || 50, cwd: os.homedir() });
  control.on('output', (pane, data) => {
    if (!out.has(pane) || hints.has(pane)) return;
    const text = (out.get(pane) + data.toString('utf8')).slice(-8000);
    out.set(pane, text);
    const hint = findResumeHint(text);
    if (hint) hints.set(pane, hint.command);
  });
  control.on('stderr', () => {});
  let left = agents.map((a) => a.id);
  const started = Date.now();
  let presses = 0;
  while (left.length && Date.now() - started < TIMEOUT_MS) {
    if (presses < CTRL_C_AT_MS.length && Date.now() - started >= CTRL_C_AT_MS[presses]) {
      for (const pane of left) control.run(`send-keys -t ${pane} C-c`);
      presses++;
    }
    await sleep(POLL_MS);
    const now = await panesOf(session, target);
    left = left.filter((id) => now.find((p) => p.id === id)?.running?.agent);
  }
  // A moment for the last of the resume line to arrive.
  if (agents.some((a) => !hints.has(a.id))) await sleep(300);
  control.close();
  if (left.length) log(`${left.length} agent(s) did not leave in ${TIMEOUT_MS / 1000}s: ${left.join(' ')}`);
  return agents.map((a) => ({
    pane: a.id,
    window: a.window,
    active: a.active,
    dir: a.path,
    agent: a.running.agent,
    command: resumeCommand(a.running.agent, a.running.args, hints.get(a.id) ?? null),
  }));
}
