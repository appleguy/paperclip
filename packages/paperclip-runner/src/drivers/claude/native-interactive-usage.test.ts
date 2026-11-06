import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
    await writeFile(join(directory, `${sessionId}.jsonl`), [
      entry(sessionId, { input_tokens: 100, cache_read_input_tokens: 20000, cache_creation_input_tokens: 500, output_tokens: 40 }),
      entry(sessionId, { input_tokens: 500, cache_read_input_tokens: 2000, output_tokens: 10 }),
      entry("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { input_tokens: 99999, output_tokens: 1 }),
      entry(sessionId, { input_tokens: -1, output_tokens: 1 }),
      '{"incomplete":',
    ].join("\n"));
    expect(await ClaudeInteractiveNativeBackend.transcriptPeak({ home: root, claudeConfigDir: join(root, "config"), cwd, sessionId })).toBe(20640);
    expect(await ClaudeInteractiveNativeBackend.transcriptPeak({ home: root, cwd, sessionId })).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
