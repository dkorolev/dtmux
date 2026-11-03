// The line an agent prints when you leave it, telling you how to come back.
// Recognises Claude, Codex, and the Cursor agent. Anything else is ignored.
// The command must be followed by a newline: output arrives in chunks, and a
// line cut off mid-command must wait for the rest, not be taken as it is.
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

// Claude Code prints "Resume this session with:" and then one of
//   claude --resume <id>                  (or no id)
//   claude <launch flags> --resume <id>
//   claude --worktree "<name>" --resume <id>   claude -w "<name>" -r <id>
//   VAR=value claude ...
const CLAUDE = /Resume this session with:[ \t]*\n?[ \t]*((?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*claude\b[^\n]*?)[ \t]*\n/;
const CODEX = /(?:To reconnect, run|To continue this session, run):\s*(codex resume\b[^\n]*?)[ \t]*\n/i;
const CURSOR = [
  /To resume this session:[ \t]*((?:cursor agent|cursor-agent|agent-local|agent) --resume=\S+)[ \t]*\n/,
  /To resume the previous conversation use\s+((?:cursor-agent|agent) --resume \S+)[ \t]*\n/,
];

export function findResumeHint(text) {
  const plain = text.replace(ANSI, '').replace(/\r/g, '');
  const claude = plain.match(CLAUDE);
  if (claude) return { agent: 'claude', command: claude[1].trim() };
  const codex = plain.match(CODEX);
  if (codex) return { agent: 'codex', command: codex[1].trim() };
  for (const re of CURSOR) {
    const cursor = plain.match(re);
    if (cursor) return { agent: 'cursor', command: cursor[1].trim() };
  }
  return null;
}
