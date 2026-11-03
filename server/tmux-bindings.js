// tmux UI that a control-mode client cannot show, and what to do instead.
//
// A key binding that opens tmux's command prompt or a confirmation (rename
// window, kill pane, the ":" prompt) would open it on the browser's control
// client. tmux then stops reading commands from that client until the prompt
// closes, and the browser can neither see nor answer it: the page is stuck.
// So such bindings are recognised before they run and asked in the browser
// instead; the answer runs the binding's command, as tmux would.

// Split a tmux command string (as list-keys prints it) into commands, each a
// list of words. A { block } stays one word with its raw text.
export function tokenize(str) {
  const cmds = [[]];
  const n = str.length;
  const space = (c) => c === undefined || c === ' ' || c === '\t' || c === '\n';
  let i = 0;
  while (i < n) {
    const c = str[i];
    if (space(c)) {
      i++;
    } else if ((c === ';' && space(str[i + 1])) || (c === '\\' && str[i + 1] === ';' && space(str[i + 2]))) {
      cmds.push([]);
      i += c === ';' ? 1 : 2;
    } else if (c === '{') {
      const end = blockEnd(str, i);
      cmds.at(-1).push({ text: str.slice(i + 1, end).trim(), block: true });
      i = end + 1;
    } else {
      let w = '';
      let sep = false;
      while (i < n && !space(str[i])) {
        const ch = str[i];
        if (ch === '"') {
          for (i++; i < n && str[i] !== '"'; i++) {
            if (str[i] === '\\' && i + 1 < n) w += unescape(str[++i]);
            else w += str[i];
          }
          i++;
        } else if (ch === "'") {
          for (i++; i < n && str[i] !== "'"; i++) w += str[i];
          i++;
        } else if (ch === ';' && space(str[i + 1])) {
          sep = true;
          i++;
          break;
        } else if (ch === '\\' && i + 1 < n) {
          if (str[i + 1] === ';' && space(str[i + 2])) {
            sep = true;
            i += 2;
            break;
          }
          w += str[i + 1];
          i += 2;
        } else {
          w += ch;
          i++;
        }
      }
      cmds.at(-1).push({ text: w, block: false });
      if (sep) cmds.push([]);
    }
  }
  return cmds.filter((c) => c.length);
}
const unescape = (c) => ({ n: '\n', t: '\t', r: '\r', e: '\x1b' })[c] ?? c;

function blockEnd(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (c === '"' || c === "'") {
      for (i++; i < str.length && str[i] !== c; i++) if (c === '"' && str[i] === '\\') i++;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return str.length;
}

// getopt over words: boolean flags, flags that take a value, then the rest.
function getopt(words, valueFlags) {
  const flags = new Set();
  const values = {};
  let i = 0;
  for (; i < words.length; i++) {
    const { text, block } = words[i];
    if (block || !text.startsWith('-') || text === '-') break;
    if (text === '--') {
      i++;
      break;
    }
    for (let k = 1; k < text.length; k++) {
      if (valueFlags.includes(text[k])) {
        values[text[k]] = text.slice(k + 1) || (words[++i]?.text ?? '');
        break;
      }
      flags.add(text[k]);
    }
  }
  return { flags, values, rest: words.slice(i) };
}

// Rebuild a command from its words, for running it ourselves.
function joinCommand(words) {
  if (words.length === 1) return words[0].text;
  return words
    .map((w, i) => (w.block ? `{ ${w.text} }` : i === 0 ? w.text : '"' + w.text.replace(/[\\"$]/g, '\\$&') + '"'))
    .join(' ');
}

// What a binding's command needs from the browser, or null to let tmux run it.
//   { kind: 'prompt', prompts, inputs, template, formatTemplate, single, numeric }
//   { kind: 'confirm', prompt, command, confirmKey, enterConfirms }
// prompts, inputs and the confirm prompt are still tmux formats.
export function parseBinding(command) {
  if (typeof command !== 'string') return null;
  const cmds = tokenize(command);
  if (cmds.length !== 1 || cmds[0][0].block) return null;
  const [name, ...args] = cmds[0];
  if (name.text === 'command-prompt') {
    const { flags, values, rest } = getopt(args, 'IptT');
    if (values.t) return null; // aimed at some other client
    const split = (s) => (flags.has('l') ? [s] : s.split(','));
    const template = rest.length ? joinCommand(rest) : '%1';
    const prompts = values.p !== undefined ? split(values.p) : [rest.length ? `(${template.split(/\s/)[0]})` : ':'];
    return {
      kind: 'prompt',
      prompts,
      inputs: values.I !== undefined ? split(values.I) : [],
      template,
      formatTemplate: flags.has('F'),
      single: flags.has('1') || flags.has('k'),
      numeric: flags.has('N'),
    };
  }
  if (name.text === 'confirm-before' || name.text === 'confirm') {
    const { flags, values, rest } = getopt(args, 'cpt');
    if (values.t || !rest.length) return null;
    const cmd = joinCommand(rest);
    return {
      kind: 'confirm',
      prompt: values.p ?? `Confirm '${cmd}'? (y/n)`,
      command: cmd,
      confirmKey: values.c || 'y',
      enterConfirms: flags.has('y'),
    };
  }
  return null;
}

// tmux's cmd_template_replace: the first "%%" and every "%<idx>" become s;
// "%%%" (or "%<idx>%") escapes the quoting characters in s.
export function templateReplace(template, s, idx) {
  if (!template.includes('%')) return template;
  let out = '';
  let replaced = false;
  for (let i = 0; i < template.length;) {
    const ch = template[i++];
    if (ch !== '%') {
      out += ch;
      continue;
    }
    const next = template[i];
    if (next === String(idx)) {
      // "%<idx>"
    } else if (next === '%' && !replaced) {
      replaced = true;
    } else {
      out += ch;
      continue;
    }
    i++;
    const quoted = template[i] === '%';
    if (quoted) i++;
    for (const c of s) out += quoted && '"\\$;~'.includes(c) ? '\\' + c : c;
  }
  return out;
}

// The command to run for a prompt's answers.
export function fillTemplate(template, answers) {
  return answers.reduce((t, a, i) => templateReplace(t, a, i + 1), template);
}
