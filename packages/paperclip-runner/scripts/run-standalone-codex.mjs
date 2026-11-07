#!/usr/bin/env node
// Prefer tracked TypeScript over stale generated siblings in a live checkout.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { register } from "tsx/esm/api";
register();
import { fileURLToPath } from "node:url";
const sourceRoot = new URL("../src/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".") && specifier.endsWith(".js")) {
      const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(fileURLToPath(source))) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { standaloneCodexMain } = await import("../src/standalone/codex-standalone.ts");
try { await standaloneCodexMain(process.argv.slice(2)); }
catch (error) {
  console.error(error instanceof Error ? error.message : "standalone Codex failed");
  process.exitCode = 1;
}
