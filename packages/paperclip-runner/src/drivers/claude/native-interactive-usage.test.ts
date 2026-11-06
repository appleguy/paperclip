import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ClaudeInteractiveNativeBackend } from "./native-interactive-backend.js";

it("reads the largest assistant context from the scoped Claude transcript", async () => {
  const root = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/claude-usage-");
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", cwd = join(root, "project");
  const project = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const directory = join(root, "config", "projects", project);
  try {
    await mkdir(cwd);
    await mkdir(directory, { recursive: true });
    const entry = (id: string, usage: object) => JSON.stringify({ type: "assistant", sessionId: id, message: { usage } });
    const path = join(directory, `${sessionId}.jsonl`);
    const scope = { home: root, claudeConfigDir: join(root, "config"), cwd, sessionId };
    const first = await ClaudeInteractiveNativeBackend.transcriptCursor(scope);
    await writeFile(path, [
      entry(sessionId, { input_tokens: 100, cache_read_input_tokens: 20000, cache_creation_input_tokens: 500, output_tokens: 40 }),
      entry(sessionId, { input_tokens: 500, cache_read_input_tokens: 2000, output_tokens: 10 }),
      entry("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { input_tokens: 99999, output_tokens: 1 }),
      entry(sessionId, { input_tokens: -1, output_tokens: 1 }),
      '{"incomplete":',
    ].join("\n") + "\n");
    expect(await ClaudeInteractiveNativeBackend.transcriptPeak(first)).toBe(20640);
    const second = await ClaudeInteractiveNativeBackend.transcriptCursor(scope);
    await appendFile(path, entry(sessionId, { input_tokens: 300, output_tokens: 20 }) + "\n");
    expect(await ClaudeInteractiveNativeBackend.transcriptPeak(second)).toBe(320);
    const missing = await ClaudeInteractiveNativeBackend.transcriptCursor({ home: root, cwd, sessionId });
    expect(await ClaudeInteractiveNativeBackend.transcriptPeak(missing)).toBeUndefined();
    const truncated = await ClaudeInteractiveNativeBackend.transcriptCursor(scope);
    await writeFile(path, "");
    expect(await ClaudeInteractiveNativeBackend.transcriptPeak(truncated)).toBeUndefined();
    await writeFile(path, '{"partial":');
    const partial = await ClaudeInteractiveNativeBackend.transcriptCursor(scope);
    await appendFile(path, 'true}\n' + entry(sessionId, { input_tokens: 7, output_tokens: 3 }) + "\n");
    expect(await ClaudeInteractiveNativeBackend.transcriptPeak(partial)).toBe(10);
  } finally { await rm(root, { recursive: true, force: true }); }
});
