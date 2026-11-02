import { describe, expect, it } from "vitest";
import { inspectCodexSharedDaemon } from "./codex-shared-daemon.js";
const dir=process.env.PAPERCLIP_CODEX_TEST_HOME,runner=process.env.PAPERCLIP_CODEX_PEER_INSPECT_BIN;
(dir && runner ? describe : describe.skip)("Codex managed daemon discovery",()=>{
  it("binds CLI metadata to a kernel-verified daemon executable and rejects a foreign home",async()=>{
    const binding=await inspectCodexSharedDaemon({codexExecutable:"/opt/homebrew/bin/codex",codexHome:dir!,home:dir!,runnerExecutable:runner!});
    expect(binding.peer.pid).toBeGreaterThan(0);expect(binding.peer.startSeconds).toBeGreaterThan(0);
    expect(binding.daemonGeneration).toMatch(/^\d+:\d+:-?\d+:\d+$/);
    await expect(inspectCodexSharedDaemon({codexExecutable:"/opt/homebrew/bin/codex",codexHome:dir!+"/missing",home:dir!,runnerExecutable:runner!})).rejects.toThrow();
  },30000);
});
