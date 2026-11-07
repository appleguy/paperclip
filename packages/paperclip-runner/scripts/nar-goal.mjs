#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
register();
const root = new URL('../src/', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) { if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')) { const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL); if (existsSync(fileURLToPath(ts))) return next(ts.href, context); } return next(specifier, context); } });
const { main } = await import('../src/standalone/nar-goal.ts');
try { console.log(JSON.stringify(await main(process.argv.slice(2)))); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
