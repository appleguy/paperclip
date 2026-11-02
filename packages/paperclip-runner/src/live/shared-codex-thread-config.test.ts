import { describe, expect, it } from "vitest";
import { createRunnerdCodexAppServerArgs } from "./runner-provider-launch.js";
import { sharedDaemonExecutableReadRoots, sharedThreadConfigFromArgs } from "./shared-codex-thread-config.js";

describe("shared daemon thread config", () => {
  it("keeps only permission profiles and the shell environment policy, later pairs winning", () => {
    const config = sharedThreadConfigFromArgs([
      "-c", 'default_permissions="p"', "-c", 'permissions.p.filesystem={":root"="none","/w"="write"}', "-c", "permissions.p.network.enabled=false",
      "-c", 'shell_environment_policy.set={PATH="/usr/bin"}', "-c", "shell_environment_policy.inherit=\"none\"", "-c", 'shell_environment_policy.inherit="core"',
      "-c", 'projects={"/w"={trust_level="trusted"}}', "--disable", "image_generation", "app-server",
    ]);
    expect(config).toEqual({
      permissions: { p: { filesystem: { ":root": "none", "/w": "write" }, network: { enabled: false } } },
      shell_environment_policy: { set: { PATH: "/usr/bin" }, inherit: "core" },
    });
  });

  it("converts the real isolated launch arguments into both Paperclip profiles", () => {
    const args = createRunnerdCodexAppServerArgs({ environment: { PATH: "/usr/bin:/bin" }, codexHome: "/tmp/sco337-home", codexCommand: "/usr/bin/true", workingDirectory: "/tmp/sco337-ws", readOnlyRoots: ["/usr/bin"] });
    const config = sharedThreadConfigFromArgs(args) as { permissions?: Record<string, { filesystem?: Record<string, string>; network?: { enabled?: boolean } }> };
    for (const profile of ["paperclip-runner-workspace-only", "paperclip-runner-workspace-read-only"]) {
      expect(config.permissions?.[profile]?.filesystem).toBeTruthy();
      expect(config.permissions?.[profile]?.network?.enabled).toBe(false);
    }
    expect(config.permissions?.["paperclip-runner-workspace-only"]?.filesystem?.["/usr/bin"]).toBe("read");
  });

  it("rejects a dangling -c and exposes the executable directory as a read root", () => {
    expect(() => sharedThreadConfigFromArgs(["-c"])).toThrow("shared_thread_config_argument_missing");
    expect(sharedDaemonExecutableReadRoots("/bin/sh")).toContain("/bin");
  });
});
