#!/usr/bin/env node
// Preflight for pc-deploy: walk the static import graph of the installed server
// entry and require every bare package it reaches to resolve, or the restart
// crash-loops ("Cannot find package") while admission is fenced.
// Usage: payload-resolve.mjs <server-dist-dir>   (entry: <dir>/index.js)
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

const root = process.argv[2];
const entry = root && path.join(root, "index.js");
if (!entry || !fs.existsSync(entry)) {
  console.error(`payload-resolve: no server entry at ${entry ?? "(none)"}`);
  process.exit(2);
}
const builtins = new Set(builtinModules);
const importRe = /^\s*(?:import|export)\s[^'"`;]*?\sfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
const seen = new Set();
const checked = new Set();
const missing = [];

const packageName = spec => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

function packageResolves(dir, pkg) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "node_modules", pkg, "package.json"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

function relativeTarget(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const p of [base, `${base}.js`, path.join(base, "index.js")]) {
    if (fs.statSync(p, { throwIfNoEntry: false })?.isFile()) return p;
  }
  return null;
}

const queue = [entry];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  for (const m of fs.readFileSync(file, "utf8").matchAll(importRe)) {
    const spec = m[1] ?? m[2];
    if (!spec || spec.startsWith("node:")) continue;
    if (spec.startsWith(".") || spec.startsWith("/")) {
      const target = relativeTarget(file, spec);
      if (target) queue.push(target);
      else missing.push(`${spec} (from ${path.relative(root, file)})`);
      continue;
    }
    const pkg = packageName(spec);
    if (builtins.has(pkg) || spec.includes(":")) continue;
    const key = `${path.dirname(file)}\0${pkg}`;
    if (checked.has(key)) continue;
    checked.add(key);
    if (!packageResolves(path.dirname(file), pkg)) missing.push(`${pkg} (from ${path.relative(root, file)})`);
  }
}

if (missing.length) {
  console.error(`payload-resolve: ${missing.length} unresolvable static import(s) reachable from index.js:\n  ${missing.slice(0, 20).join("\n  ")}`);
  process.exit(1);
}
console.log(`payload-resolve: ${seen.size} module(s) reachable from index.js resolve`);
