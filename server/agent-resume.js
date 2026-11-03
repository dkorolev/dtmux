// The command that brings a coding agent back where it was: same session,
// same launch flags, the no-questions-asked ones included.
//
// The agent's own resume line (see resume-hint.js) names the session. Claude
// Code puts most launch flags in it too; Codex and the Cursor agent do not.
// The flags the agent was started with (from `ps`) fill in what the line
// leaves out. Only flags known to be safe to repeat on resume carry over.
// `ps` loses the original quoting, so only flags whose values are one word
// are taken, and they are quoted again for the shell.

// flag -> number of value words. Aliases name their canonical flag, so a
// flag is not added twice under two spellings.
const CARRY = {
  'Claude Code': {
    '--dangerously-skip-permissions': 0,
    '--allow-dangerously-skip-permissions': 0,
    '--permission-mode': 1,
    '--model': 1,
    '--add-dir': 1,
    '--verbose': 0,
  },
  Codex: {
    '--dangerously-bypass-approvals-and-sandbox': 0,
    '--yolo': 0,
    '--full-auto': 0,
    '--approve-for-me': 0,
    '--sandbox': 1,
    '-s': ['--sandbox', 1],
    '--ask-for-approval': 1,
    '-a': ['--ask-for-approval', 1],
    '--model': 1,
    '-m': ['--model', 1],
    '--profile': 1,
    '-p': ['--profile', 1],
    '--config': 1,
    '-c': ['--config', 1],
    '--search': 0,
    '--add-dir': 1,
  },
  'Cursor Agent': {
    '--force': 0,
    '-f': ['--force', 0],
    '--yolo': ['--force', 0],
    '--model': 1,
    '--mode': 1,
    '--plan': 0,
    '--sandbox': 1,
    '--approve-mcps': 0,
    '--trust': 0,
    '--auto-review': 0,
    '--add-dir': 1,
  },
};

const PROGRAM = { 'Claude Code': 'claude', Codex: 'codex', 'Cursor Agent': 'cursor-agent' };

export function shellQuote(word) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${String(word).replaceAll("'", `'\\''`)}'`;
}

// The flags of `args` (a ps command line) that carry over, as
// [{ canonical, words }] in their original order.
export function carryFlags(agent, args) {
  const table = CARRY[agent] ?? {};
  const words = String(args).trim().split(/\s+/).slice(1);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    let word = words[i];
    let inline = null;
    const eq = word.indexOf('=');
    if (word.startsWith('--') && eq > 0) {
      inline = word.slice(eq + 1);
      word = word.slice(0, eq);
    }
    const spec = table[word];
    if (spec === undefined) continue;
    const [canonical, n] = Array.isArray(spec) ? spec : [word, spec];
    if (n === 0) out.push({ canonical, words: [word] });
    else if (inline !== null) out.push({ canonical, words: [word, inline] });
    else if (i + 1 < words.length) out.push({ canonical, words: [word, words[++i]] });
  }
  return out;
}

// Which canonical flags a command line already has.
function flagsIn(agent, command) {
  const table = CARRY[agent] ?? {};
  const have = new Set();
  for (const raw of command.split(/\s+/)) {
    const word = raw.startsWith('--') && raw.includes('=') ? raw.slice(0, raw.indexOf('=')) : raw;
    const spec = table[word];
    if (spec !== undefined) have.add(Array.isArray(spec) ? spec[0] : word);
  }
  return have;
}

// The session `args` itself resumes, if it says: claude --resume <id>,
// codex resume <id>, cursor-agent --resume=<id>.
function sessionIn(agent, args) {
  const w = String(args).trim().split(/\s+/);
  for (let i = 0; i < w.length; i++) {
    if (agent === 'Codex' && w[i] === 'resume' && w[i + 1] && !w[i + 1].startsWith('-')) return w[i + 1];
    if ((w[i] === '--resume' || w[i] === '-r') && w[i + 1] && !w[i + 1].startsWith('-')) return w[i + 1];
    if (w[i].startsWith('--resume=')) return w[i].slice('--resume='.length);
  }
  return null;
}

// The resume command. `hint` is the agent's own resume line, or null when it
// printed none (it was killed, say); then the session in `args` is resumed
// if it names one, else the agent's latest session in that directory.
export function resumeCommand(agent, args, hint) {
  const program = PROGRAM[agent];
  if (!program) return null;
  let base;
  if (hint) base = hint.trim();
  else {
    const id = sessionIn(agent, args);
    if (agent === 'Claude Code') base = id ? `claude --resume ${shellQuote(id)}` : 'claude --continue';
    else if (agent === 'Codex') base = id ? `codex resume ${shellQuote(id)}` : 'codex resume --last';
    else base = id ? `cursor-agent --resume=${shellQuote(id)}` : 'cursor-agent --continue';
  }
  const have = flagsIn(agent, base);
  const extra = carryFlags(agent, args)
    .filter((f) => !have.has(f.canonical) && (have.add(f.canonical), true))
    .flatMap((f) => f.words.map(shellQuote));
  if (!extra.length) return base;
  // Flags go right after the program (and after `resume` for Codex, whose
  // flags belong to the subcommand).
  const words = base.split(' ');
  let at = words.findIndex((w) => /(^|\/)(claude|codex|cursor-agent|agent|agent-local)$/.test(w) || w === 'cursor');
  if (at < 0) return `${base} ${extra.join(' ')}`;
  if (words[at] === 'cursor' && words[at + 1] === 'agent') at++;
  at++;
  if (agent === 'Codex' && words[at] === 'resume') at++;
  return [...words.slice(0, at), ...extra, ...words.slice(at)].join(' ');
}
