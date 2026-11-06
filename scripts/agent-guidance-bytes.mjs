#!/usr/bin/env node
// Source inventory, not a token estimate or a claim that every source is loaded.
// Markdown blocks are exact UTF-8 bytes. TS blocks include syntax and dynamic
// placeholders: upper bounds on static source, not assembled runtime prompts.
// Usage: node scripts/agent-guidance-bytes.mjs [--ref HEAD] [--path PREFIX] [--summary]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
let ref, prefix = "", summary = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--ref" && args[i + 1]) ref = args[++i];
  else if (args[i] === "--path" && args[i + 1]) prefix = args[++i];
  else if (args[i] === "--summary") summary = true;
  else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
}
function git(...argv) {
  return execFileSync("git", argv, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
const files = [...new Set((ref ? git("ls-tree", "-rz", "--name-only", ref)
  : git("ls-files", "-z", "--cached", "--others", "--exclude-standard")).split("\0"))]
  .filter((file) => file.startsWith(prefix) && (
    /^skills\/.*\.md$/.test(file) ||
    /^server\/src\/onboarding-assets\/.*\.md$/.test(file) ||
    /^(server\/src|packages\/adapters\/[^/]+\/src|packages\/adapter-utils\/src)\/.*\.tsx?$/.test(file)
  ) && !/(?:__tests__|__fixtures__|test-fixtures)\/|\.(?:test|spec)\.tsx?$/.test(file)).sort();
const inventory = files.map((file) => {
  const source = ref ? git("show", `${ref}:${file}`) : readFileSync(new URL(file, new URL("../", import.meta.url)), "utf8");
  const kind = file.endsWith(".md") ? "guidance-or-reference" : "source-upper-bound";
  // Contiguous nonblank blocks cover ALL source text, including conditional
  // wake contracts, adapter defaults, dispatch/pending-card and API instructions.
  // No keyword heuristic silently omits new injection sites.
  const blocks = [];
  for (const match of source.matchAll(/[^\r\n][^\n]*(?:\n(?!\s*\r?$)[^\n]*)*/gm)) {
    const start = source.slice(0, match.index).split("\n").length;
    blocks.push({ line: start, bytes: Buffer.byteLength(match[0]) });
  }
  return { path: file, kind, bytes: Buffer.byteLength(source), ...(summary ? {} : { blocks }) };
});
console.log(JSON.stringify({
  basis: ref ?? "working-tree",
  note: "Source inventory includes optional references and non-prompt code; do not sum it as a launch size. Adapter prompt-size tests measure assembled launch and wake prompts separately.",
  files: inventory,
}, null, 2));
