/** A deliberately small shell language with no file-writing operations.
 * This recognizes tool inputs, never prose or output claiming read-only work.
 * Anything outside this grammar still needs mutation evidence. In particular,
 * substitutions, redirections, escapes, wrappers and arbitrary Git flags do
 * not inherit the contract of a command appearing somewhere in their text.
 */
export function nonmutatingShell(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  // Separators inside quoted arguments conservatively fail the word grammar.
  // No backslash, backtick, substitution, glob, comment, redirection or job.
  const literal = "[A-Za-z0-9_./:=+,%@ -]";
  const expansion = "\\$[A-Za-z_][A-Za-z0-9_]*";
  const word = `(?:[A-Za-z0-9_./:=+,%@-]+|${expansion}|'${literal}*'|\"(?:${literal}|${expansion})*\")`;
  const words = new RegExp(`^(?:${word})(?:[ \\t]+${word})*$`);
  const parts = command.trim().split(/\s*(?:&&|\|\||;|\||\n)\s*/);
  return parts.every(part => {
    if (!words.test(part)) return false;
    if (/^(?:\/bin\/)?(?:echo|pwd|true|false)(?:[ \t]|$)/.test(part)) return true;
    return /^(?:\/bin\/)?sleep[ \t]+[0-9]+(?:\.[0-9]+)?(?:[smhd])?$/.test(part);
  });
}

/** Input of a tool whose write set is not recorded (SCO-1003). */
export type OpaqueInput = { tool: string; text: string };

// Commands that read files. A redirection, substitution or write flag still
// makes the segment a writer.
const READERS = new Set(["rg", "grep", "egrep", "fgrep", "cat", "head", "tail", "less", "more", "wc", "ls", "stat", "file",
  "jq", "echo", "printf", "pwd", "true", "false", "sleep", "date", "which", "type", "printenv", "basename", "dirname",
  "realpath", "readlink", "diff", "cmp", "uniq", "cut", "tr", "column", "nl", "fd", "tree", "du", "df", "ps", "pgrep",
  "lsof", "whoami", "id", "uname", "hostname", "sw_vers", "pcview", "pcsafe", "test", "[", "shasum", "md5", "cd",
  "sed", "find", "curl", "sort", "git", "awk"]);
const GIT_READERS = new Set(["status", "log", "diff", "show", "rev-parse", "merge-base", "cat-file", "ls-files", "blame",
  "describe", "shortlog", "grep", "for-each-ref", "name-rev", "rev-list", "branch", "remote", "fetch", "config", "reflog"]);

/** Strip heredoc bodies: their text is data written to a stream, never command words. */
function withoutHeredocs(command: string): string {
  const out: string[] = [];
  let end: { tag: string; dash: boolean } | null = null;
  for (const line of command.split("\n")) {
    if (end) {
      if ((end.dash ? line.replace(/^\t+/, "") : line) === end.tag) end = null;
      continue;
    }
    out.push(line);
    const m = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (m) end = { tag: m[3], dash: m[1] === "-" };
  }
  return out.join("\n");
}

/** Quote-aware split on command separators: ; & | and newlines. */
function segments(command: string): string[] {
  const parts: string[] = [];
  let cur = "", quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === "\"" && i + 1 < command.length) cur += command[++i];
      else if (ch === quote) quote = null;
    } else if (ch === "\\" && i + 1 < command.length) cur += ch + command[++i];
    else if (ch === "'" || ch === "\"") { quote = ch; cur += ch; }
    // Keep the & of 2>&1, >&2 and &> inside its segment.
    else if (ch === "&" && (cur.endsWith(">") || cur.endsWith("<") || command[i + 1] === ">")) cur += ch;
    else if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") { if (cur.trim()) parts.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** True unless the segment is a known reader with no write syntax. */
function writes(segment: string): boolean {
  if (/\$\(|`|<\(|>\(/.test(segment)) return true;
  const stripped = segment.replace(/\d*>>?\s*\/dev\/null/g, "").replace(/\d*>&\s*\d/g, "");
  if (/(^|[^<])>/.test(stripped.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''"))) return true;
  const words = segment.split(/\s+/).filter(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const name = (words[0] ?? "").replace(/^.*\//, "");
  if (!READERS.has(name)) return true;
  const rest = words.slice(1);
  if (name === "sed") return rest.some(w => /^-[A-Za-z]*i|^--in-place/.test(w));
  if (name === "find") return rest.some(w => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(w));
  if (name === "curl") return rest.some(w => /^-[A-Za-z]*[oO]|^--(output|remote-name|create-dirs)/.test(w));
  if (name === "sort") return rest.some(w => /^-[A-Za-z]*o|^--output/.test(w));
  if (name === "awk") return /\bsystem\s*\(|-i\s*inplace|>/.test(segment);
  if (name === "git") {
    let i = 0;
    while (i < rest.length && rest[i].startsWith("-")) i += rest[i] === "-C" || rest[i] === "-c" ? 2 : 1;
    const sub = rest[i] ?? "";
    if (!GIT_READERS.has(sub)) return true;
    return rest.slice(i + 1).some(w => /^--output/.test(w)) || (sub === "branch" && rest.length > i + 1)
      || (sub === "config" && !rest.slice(i + 1).some(w => /^--(get|list)/.test(w)));
  }
  return false;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a writing segment names the file by absolute path, repo path or basename. */
function names(text: string, absolute: string, rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  return [absolute, rel, base].some(name =>
    new RegExp(`(^|[^A-Za-z0-9_.-])${escape(name)}($|[^A-Za-z0-9_.-])`).test(text));
}

/**
 * SCO-1003: a dispatch-delta path counts as this run's only when one of its
 * opaque tools could have written it. A shell segment does if it writes and
 * names the file. Any other tool does if an input value is the path itself.
 * Concurrent runs' dirt on a shared checkout is never attributed by default.
 */
export function opaqueWriterOf(inputs: OpaqueInput[], absolute: string, rel: string): boolean {
  return inputs.some(({ tool, text }) => tool === "Bash"
    ? segments(withoutHeredocs(text)).some(segment => writes(segment) && names(segment, absolute, rel))
    : pathValues(text).some(v => v === absolute || v === rel || v.endsWith(`/${rel}`)));
}

function pathValues(json: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") { if (v.includes("/") && !/\s/.test(v)) out.push(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  try { walk(JSON.parse(json)); } catch { /* unreadable input names nothing */ }
  return out;
}
