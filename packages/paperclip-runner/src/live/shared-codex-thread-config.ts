import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "smol-toml";

/** Config keys a shared-daemon `thread/start.config` may carry; everything else in the launch arguments stays launch-only. */
const THREAD_CONFIG_KEYS = new Set(["permissions", "shell_environment_policy", "web_search"]);
export const SHARED_WRITABLE_PROFILE = "paperclip-runner-workspace-only";
export const SHARED_READ_ONLY_PROFILE = "paperclip-runner-workspace-read-only";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isRecord(value) && isRecord(existing)) merge(existing, value);
    else target[key] = value;
  }
}

/**
 * A registered shared daemon was not launched with Paperclip's `-c` arguments, so the permission profile a managed
 * thread runs under must be defined per thread. Converts the isolated launch arguments (`-c key=value` pairs, TOML
 * values) into the JSON object `thread/start.config` accepts, keeping only permission profiles and the shell
 * environment policy. Later pairs win, as they do for the Codex CLI.
 */
export function sharedThreadConfigFromArgs(args: readonly string[]): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-c") continue;
    const pair = args[index + 1];
    index += 1;
    if (typeof pair !== "string") throw new Error("shared_thread_config_argument_missing");
    const root = pair.slice(0, pair.indexOf("=")).split(".")[0]?.trim();
    if (!root || !THREAD_CONFIG_KEYS.has(root)) continue;
    merge(config, parse(pair) as Record<string, unknown>);
  }
  return config;
}

const SHELL_POLICY_KEYS = new Set(["inherit", "ignore_default_excludes", "include_only", "set"]);

/**
 * Narrow, fail-closed check of a shared-daemon thread config against Core's selected policy (the Rust writer validation
 * repeats it). Returns the first violation or null. The host resolves paths, so only the shape is checked here: exactly the
 * two Paperclip profiles, no root/tmp access, workspace-only writes, no network, an environment policy that inherits nothing,
 * and the web-search setting Core selected.
 */
export function sharedThreadConfigViolation(config: unknown, policy: { cwd: string; readOnly: boolean; disableWebSearch: boolean }): string | null {
  if (!isRecord(config)) return "config_missing";
  if (Object.keys(config).some((key) => !THREAD_CONFIG_KEYS.has(key))) return "config_key_unknown";
  if (config.web_search !== undefined && config.web_search !== "disabled") return "web_search_widened";
  if (policy.disableWebSearch && config.web_search !== "disabled") return "web_search_not_disabled";
  const profiles = config.permissions;
  if (!isRecord(profiles) || Object.keys(profiles).length !== 2) return "profiles_invalid";
  const cwd = policy.cwd;
  if (!cwd.startsWith("/") || cwd === "/" || cwd.split("/").some((part) => part === ".." || part === ".")) return "cwd_invalid";
  for (const [name, mode] of [[SHARED_WRITABLE_PROFILE, "write"], [SHARED_READ_ONLY_PROFILE, "read"]] as const) {
    const profile = profiles[name];
    if (!isRecord(profile) || Object.keys(profile).some((key) => key !== "filesystem" && key !== "network")) return "profile_invalid";
    const filesystem = profile.filesystem;
    if (!isRecord(filesystem) || Object.keys(filesystem).length > 256) return "filesystem_invalid";
    const workspace = filesystem[":workspace_roots"];
    if (filesystem[":root"] !== "none" || filesystem[":minimal"] !== "read" || filesystem[":tmpdir"] !== "none"
      || !isRecord(workspace) || Object.keys(workspace).length !== 1 || workspace["."] !== mode) return "filesystem_widened";
    for (const [path, access] of Object.entries(filesystem)) {
      if (path.startsWith(":")) { if (![":root", ":minimal", ":tmpdir", ":workspace_roots"].includes(path)) return "filesystem_special_unknown"; continue; }
      if (!path.startsWith("/") || path.length > 4096 || /[\u0000-\u001f]/.test(path) || path.split("/").some((part) => part === ".." || part === ".")) return "filesystem_path_invalid";
      if (path === "/" && access !== "none") return "filesystem_root_widened";
      if (access !== "none" && access !== "read" && access !== "write") return "filesystem_access_invalid";
      if (access === "write" && (policy.readOnly || mode === "read" || !(path === cwd || path.startsWith(`${cwd}/`)))) return "filesystem_write_outside_workspace";
    }
    const network = profile.network;
    if (!isRecord(network) || Object.keys(network).length !== 1 || typeof network.enabled !== "boolean") return "network_invalid";
  }
  const env = config.shell_environment_policy;
  if (env !== undefined) {
    if (!isRecord(env) || Object.keys(env).some((key) => !SHELL_POLICY_KEYS.has(key)) || env.inherit !== "none") return "shell_environment_widened";
    if (env.ignore_default_excludes !== undefined && typeof env.ignore_default_excludes !== "boolean") return "shell_environment_invalid";
    if (env.include_only !== undefined && (!Array.isArray(env.include_only) || env.include_only.some((name) => typeof name !== "string"))) return "shell_environment_invalid";
    if (env.set !== undefined && (!isRecord(env.set) || Object.values(env.set).some((value) => typeof value !== "string"))) return "shell_environment_invalid";
  } else return "shell_environment_missing";
  return null;
}

/** The sandbox helper re-executes the daemon's own binary, so its directory (and the symlink target's) must be readable. */
export function sharedDaemonExecutableReadRoots(executable: string): string[] {
  const roots = new Set<string>([dirname(executable)]);
  try { roots.add(dirname(realpathSync(executable))); } catch { /* an unreadable path is refused by the daemon peer check */ }
  return [...roots];
}
