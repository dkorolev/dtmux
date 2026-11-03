// The line an agent prints when you leave it, telling you how to come back.
// Recognises Claude, Codex, and the Cursor agent. Anything else is ignored.
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

export function findResumeHint(text) {
  const plain = text.replace(ANSI, '').replace(/\r/g, '');
  const claude = plain.match(/Resume this session with:\s*(claude --resume \S[^\n]*)/);
  if (claude) return { agent: 'claude', command: claude[1].trim() };
  const codex =
    plain.match(/To reconnect, run:\s*(codex resume\b[^\n]*)/i) ||
    plain.match(/To continue this session, run:\s*(codex resume\b[^\n]*)/i);
  if (codex) return { agent: 'codex', command: codex[1].trim() };
  const cursor =
    plain.match(/To resume this session:\s*((?:cursor agent|agent-local|agent) --resume=\S+)/) ||
    plain.match(/To resume the previous conversation use\s+(agent --resume \S+)/);
  if (cursor) return { agent: 'cursor', command: cursor[1].trim() };
  return null;
}
