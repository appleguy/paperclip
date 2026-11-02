import { spawn, execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { readProcessStartedAt } from "../hot-restart.js";
import { OpenCodeV2Shared, startOpenCodeMcpBridge, type V2Binding, type V2Event } from "../../vendor/paperclip-runner/index.js";
import { createOpenCodeBoundFetch } from "./opencode-bound-fetch.js";
import { verifyOpenCodeNativeCatalog } from "./opencode-native-catalog.js";
import { createOpenCodeSharedObserver } from "./opencode-shared-observer.js";
import { validateOpenCodeLogItem, type OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import { completeOpenCodeSessionCreation, deliverOpenCodeMcpRestoration, persistOpenCodeHost, readOpenCodeHost, readOpenCodeHostRestoration, reserveOpenCodeMcpRestoration } from "./opencode-shared-recovery.js";
import { nativeSha256 } from "./canonical.js";
import { createOpenCodeManagedMutation } from "./opencode-managed-mutation.js";
import { createOpenCodeMcpAdmission } from "./opencode-mcp-admission.js";
import { startOpenCodeScopedListener } from "./opencode-scoped-listener.js";

const execute = promisify(execFile);

function assertSessionModel(value: unknown, binding: Pick<OpenCodeSharedBinding, "model" | "effort">) {
  const session = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const model = session.model && typeof session.model === "object" && !Array.isArray(session.model) ? session.model as Record<string, unknown> : {};
  const slash = binding.model.indexOf("/");
  if (slash <= 0 || slash === binding.model.length - 1 || binding.model.includes("#") || model.providerID !== binding.model.slice(0, slash) || model.id !== binding.model.slice(slash + 1) || model.variant !== binding.effort) throw new Error("opencode_session_model_mismatch");
}

/** Start one isolated, host-owned v2 server. Never accepts URL or credentials
 * from a client. The returned handle is valid only while this process lives. */
export async function startOpenCodeSharedHost(input: { executable: string; dataRoot: string; workspaceCwd?: string; provider?: { provider: string; model: string; baseURL: string; token: string }; onShutdown?: () => Promise<void>; mcp?: {
  tools: readonly Readonly<Record<string, unknown>>[];
  createHandler: (binding: OpenCodeSharedBinding) => (call: { tool: string; callId: string; arguments: unknown; signal: AbortSignal }) => Promise<unknown>;
} }) {
  if (!isAbsolute(input.executable) || !isAbsolute(input.dataRoot) || (input.workspaceCwd !== undefined && !isAbsolute(input.workspaceCwd))) throw new Error("opencode_host_configuration_invalid");
  if (input.workspaceCwd !== undefined && await realpath(input.workspaceCwd) !== input.workspaceCwd) throw new Error("opencode_workspace_not_canonical");
  const version = await execute(input.executable, ["--version"], { timeout: 5000, maxBuffer: 4096 });
  if (version.stdout.trim() !== "opencode v2.2.5") throw new Error("opencode_host_version_unsupported");
  await mkdir(input.dataRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(input.dataRoot, "opencode-shared-"));
  for (const dir of ["home", "config", "data", "cache", "state", "work"]) await mkdir(join(root, dir), { mode: 0o700 });
  const workingDirectory = input.workspaceCwd ?? join(root, "work");
  const password = randomBytes(32).toString("hex");
  let admitted: { check: ReturnType<typeof createOpenCodeMcpAdmission>; handle: ReturnType<NonNullable<typeof input.mcp>["createHandler"]> } | undefined;
  const bridge = input.mcp ? await startOpenCodeMcpBridge({ tools: input.mcp.tools,
    admitSharedCall: async peer => { if (!admitted) throw new Error("opencode_mcp_unbound"); await admitted.check(peer); },
    handler: async call => { if (!admitted) throw new Error("opencode_mcp_unbound"); return admitted.handle(call); },
  }) : undefined;
  const config = { ...(input.provider ? { providers: { [input.provider.provider]: { package: "@opencode/ai/providers/openai-compatible", name: input.provider.provider, settings: { baseURL: input.provider.baseURL, apiKey: "{env:PAPERCLIP_PROVIDER_TOKEN}" }, models: { [input.provider.model]: { name: input.provider.model } } } } } : {}), ...(bridge ? { mcp: { servers: { paperclip: { type: "remote", url: bridge.url, headers: { Authorization: "Bearer {env:PAPERCLIP_MCP_TOKEN}" }, oauth: false, codemode: false } } } } : {}) };
  const mcpEnv = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), ...(bridge ? { PAPERCLIP_MCP_TOKEN: bridge.secret } : {}), ...(input.provider ? { PAPERCLIP_PROVIDER_TOKEN: input.provider.token } : {}) };
  const child = spawn(input.executable, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: workingDirectory, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_PASSWORD: password, ...mcpEnv },
  });
  const childPid = child.pid;
  if (!childPid) { child.once("error", () => {}); await bridge?.close(); throw new Error("opencode_host_spawn_failed"); }
  const pid: number = childPid;
  let alive = true;
  const exited = new Promise<void>(resolve => child.once("exit", () => { alive = false; resolve(); }));
  let shuttingDown: Promise<void> | undefined;
  const listeners = new Set<Awaited<ReturnType<typeof startOpenCodeScopedListener>>>();
  // The durable lease reader uses NOWAIT row locks. TUI bootstrap and multiple
  // observers issue concurrent reads; serialize this host's own checks so they
  // do not reject one another while retaining cross-controller fencing.
  let ingressTail: Promise<void> = Promise.resolve();
  async function withIngressCheck<T>(operation: () => Promise<T>): Promise<T> {
    const result = ingressTail.then(operation);
    ingressTail = result.then(() => undefined, () => undefined);
    return result;
  }
  function shutdown() {
    return shuttingDown ??= (async () => {
      admitted = undefined;
      await Promise.all([...listeners].map(listener => listener.close()));
      listeners.clear();
      if (!alive) { await bridge?.close(); await input.onShutdown?.(); return; }
      // Only this live ChildProcess handle is ever signalled; no PID lookup,
      // persisted identity, process group, or reattached process is signalled.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (child.exitCode !== null || child.signalCode !== null || !child.kill("SIGTERM")) throw new Error("opencode_host_shutdown_unconfirmed");
        await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("opencode_host_shutdown_timeout")), 5000); })]);
      } finally { if (timer) clearTimeout(timer); await bridge?.close(); await input.onShutdown?.(); }
    })();
  }
  try {
  child.stderr.resume();
  let buffer = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("opencode_host_start_timeout")), 10_000);
    const done = (error?: Error, value?: number) => { clearTimeout(timer); child.stdout.removeListener("data", onData); child.stdout.resume(); error ? reject(error) : resolve(value!); };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 16384) { done(new Error("opencode_host_start_invalid")); return; }
      const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) done(undefined, Number(match[1]));
    };
    child.once("error", () => done(new Error("opencode_host_spawn_failed")));
    child.once("exit", () => done(new Error("opencode_host_start_failed")));
    child.stdout.on("data", onData);
  });
  buffer = ""; // The native banner can contain the password; never log or return it.
  const generation = randomUUID();
  const boundFetch = createOpenCodeBoundFetch({ pid, port, isAlive: () => alive, allowEmptySessionCreate: true });
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const origin = `http://127.0.0.1:${port}`;
  async function verifyHost() {
    if (!alive) throw new Error("opencode_host_exited");
    const response = await boundFetch(`${origin}/api/info`, { headers: { authorization }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("opencode_host_authentication_failed");
    const info = await response.json() as { pid?: unknown; version?: unknown };
    if (info.pid !== pid || info.version !== "2.2.5") throw new Error("opencode_host_identity_mismatch");
  }
  await verifyHost();
  async function verifySession(sessionId: string, expected?: Pick<OpenCodeSharedBinding, "model" | "effort">) {
      if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("opencode_session_invalid");
      await verifyHost();
      const response = await boundFetch(`${origin}/api/session/${encodeURIComponent(sessionId)}`, { headers: { authorization }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("opencode_session_unavailable");
      const body = await response.json() as { data?: { id?: unknown; location?: { directory?: unknown } } };
      if (body.data?.id !== sessionId) throw new Error("opencode_session_mismatch");
      if (input.workspaceCwd !== undefined && body.data.location?.directory !== workingDirectory) throw new Error("opencode_session_workspace_mismatch");
      if (expected) assertSessionModel(body.data, expected);
      await verifyHost();
      return Object.freeze({ sessionId, generation, version: "2.2.5" as const });
  }
  let creationAttempted = false;
  async function dispatchForRun(db: Db, binding: OpenCodeSharedBinding, prompt: { id: string; text: string; delivery?: "steer" | "queue"; resume?: boolean }) {
    if (binding.generation !== generation || binding.version !== "2.2.5") throw new Error("opencode_host_binding_mismatch");
    await verifySession(binding.providerSessionId, binding);
    const fetch = createOpenCodeBoundFetch({ pid, port, isAlive: () => alive, allowPromptForSession: binding.providerSessionId });
    const managed = createOpenCodeManagedMutation(db, { binding, fetch, admission: { baseUrl: origin, authorization,
      async attest(identity) { if (identity.sessionId !== binding.providerSessionId || identity.generation !== generation) throw new Error("opencode_host_binding_mismatch"); await verifyHost(); },
    } });
    return managed.dispatch(prompt);
  }
  return Object.freeze({
    generation,
    shutdown,
    verifySession,
    async verifyCatalog(model: string, effort: string) {
      if (!input.provider || `${input.provider.provider}/${input.provider.model}` !== model) throw new Error("opencode_native_catalog_identity_invalid");
      await verifyHost();
      await verifyOpenCodeNativeCatalog({ fetch: boundFetch, origin, authorization, directory: workingDirectory, model, effort, providerBaseURL: input.provider.baseURL, providerToken: input.provider.token });
      await verifyHost();
    },
    async prepareManagedSession(db: Db, binding: OpenCodeSharedBinding) {
      if (!input.workspaceCwd || !input.mcp || binding.generation !== generation || !/^ses_[A-Za-z0-9_-]+$/.test(binding.providerSessionId)) throw new Error("opencode_creation_binding_invalid");
      const slash = binding.model.indexOf("/");
      if (slash <= 0 || slash === binding.model.length - 1 || binding.model.includes("#") || !binding.effort) throw new Error("opencode_creation_binding_invalid");
      await verifyHost();
      const startedAt = await readProcessStartedAt(pid);
      const executable = (await execute("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 3000, maxBuffer: 4096 })).stdout.trim();
      if (!startedAt || !alive || !isAbsolute(executable)) throw new Error("opencode_host_birth_unavailable");
      const intent = { sessionId: binding.providerSessionId, model: binding.model, effort: binding.effort, workingDirectory };
      await persistOpenCodeHost(db, binding, { pid, startedAt, executable, port, namespace: root, workingDirectory, generation, password, ...(input.provider ? { proxy: { baseURL: input.provider.baseURL, token: input.provider.token } } : {}) }, intent);
    },
    async createManagedSession(db: Db, binding: OpenCodeSharedBinding, prepared = false) {
      if (!prepared) await this.prepareManagedSession(db, binding);
      if (!input.workspaceCwd || !input.mcp || binding.generation !== generation) throw new Error("opencode_creation_binding_invalid");
      const slash = binding.model.indexOf("/");
      const body = JSON.stringify({ id: binding.providerSessionId, model: { providerID: binding.model.slice(0, slash), id: binding.model.slice(slash + 1), variant: binding.effort }, location: { directory: workingDirectory } });
      const send = createOpenCodeBoundFetch({ pid, port, isAlive: () => alive, allowExactSessionCreateBody: body });
      const response = await send(`${origin}/api/session`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("opencode_creation_outcome_unknown");
      await verifySession(binding.providerSessionId, binding);
      await completeOpenCodeSessionCreation(db, binding, workingDirectory);
      admitted = { check: createOpenCodeMcpAdmission(db, binding), handle: input.mcp.createHandler(binding) };
    },
    async reconcileManagedSession(db: Db, binding: OpenCodeSharedBinding) {
      if (!input.workspaceCwd || !input.mcp || binding.generation !== generation) throw new Error("opencode_creation_binding_invalid");
      await verifySession(binding.providerSessionId, binding);
      await completeOpenCodeSessionCreation(db, binding, workingDirectory);
      admitted = { check: createOpenCodeMcpAdmission(db, binding), handle: input.mcp.createHandler(binding) };
    },
    async startScopedIngress(db: Db, binding: OpenCodeSharedBinding) {
      if (shuttingDown || binding.generation !== generation) throw new Error("opencode_host_binding_mismatch");
      await readOpenCodeHost(db, binding);
      await verifySession(binding.providerSessionId, binding);
      const listener = await startOpenCodeScopedListener({ sessionId: binding.providerSessionId, workspaceDirectory: workingDirectory,
        async attestEvent() { await withIngressCheck(async () => { await readOpenCodeHost(db, binding); await verifySession(binding.providerSessionId, binding); await readOpenCodeHost(db, binding); }); },
        async read(path, signal) {
          return withIngressCheck(async () => { await readOpenCodeHost(db, binding); await verifySession(binding.providerSessionId, binding); await readOpenCodeHost(db, binding); return boundFetch(`${origin}${path}`, { headers: { authorization }, signal }); });
        },
        dispatch: prompt => dispatchForRun(db, binding, prompt),
      });
      if (shuttingDown) { await listener.close(); throw new Error("opencode_host_exited"); }
      listeners.add(listener);
      return listener;
    },
    async persistForRun(db: Db, binding: OpenCodeSharedBinding) {
      if (binding.generation !== generation) throw new Error("opencode_host_binding_mismatch");
      await verifySession(binding.providerSessionId, binding);
      const startedAt = await readProcessStartedAt(pid);
      if (!startedAt || !alive) throw new Error("opencode_host_birth_unavailable");
      const executable = (await execute("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 3000, maxBuffer: 4096 })).stdout.trim();
      if (!executable.startsWith("/")) throw new Error("opencode_host_executable_unavailable");
      await verifyHost();
      await persistOpenCodeHost(db, binding, { pid, startedAt, executable, port, namespace: root, workingDirectory, generation, password });
      if (input.mcp) admitted = { check: createOpenCodeMcpAdmission(db, binding), handle: input.mcp.createHandler(binding) };
    },
    async createEmptyObservation() {
      if (creationAttempted) throw new Error("opencode_empty_session_already_attempted");
      creationAttempted = true; // A lost acknowledgement is unknown, never retry.
      await verifyHost();
      const response = await boundFetch(`${origin}/api/session`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("opencode_session_creation_failed");
      const body = await response.json() as { data?: { id?: unknown } };
      if (typeof body.data?.id !== "string") throw new Error("opencode_session_creation_invalid");
      const binding = await verifySession(body.data.id);
      const synced = Symbol("synced");
      let count = 0;
      const client = new OpenCodeV2Shared({ baseUrl: origin, binding, headers: { authorization }, fetch: boundFetch, authority: {
        async attest(identity: V2Binding) { if (identity.sessionId !== binding.sessionId || identity.generation !== generation) throw new Error("opencode_host_binding_mismatch"); await verifyHost(); },
        async withMutation() { throw new Error("opencode_shared_mutation_not_admitted"); },
        async loadCursor() { return null; },
        async commitLog(_identity: V2Binding, previous: number | null, next: number | null, item: V2Event) {
          validateOpenCodeLogItem(binding.sessionId, previous, next, item);
          if (++count > 128) throw new Error("opencode_observation_limit");
          if (item.type === "log.synced") throw synced;
        },
      } });
      try { await client.follow(AbortSignal.timeout(10_000)); } catch (error) { if (error !== synced) throw error; }
      if (!count) throw new Error("opencode_observation_unsynchronized");
      return { ...binding, observed: true, managed: false };
    },
    async observe(db: Db, binding: OpenCodeSharedBinding, signal?: AbortSignal, onObserved?: (item: V2Event) => void) {
      if (binding.generation !== generation || binding.version !== "2.2.5") throw new Error("opencode_host_binding_mismatch");
      await verifySession(binding.providerSessionId, binding);
      const observer = createOpenCodeSharedObserver(db, { binding, fetch: boundFetch, onObserved, admission: {
        baseUrl: origin, authorization,
        async attest(identity) {
          if (identity.generation !== generation || identity.sessionId !== binding.providerSessionId || identity.version !== "2.2.5") throw new Error("opencode_host_binding_mismatch");
          await verifyHost();
        },
      } });
      await observer.observe(signal);
    },
    dispatchForRun,
  });
  } catch (error) {
    try { await shutdown(); } catch { throw new Error("opencode_host_start_cleanup_unconfirmed", { cause: error }); }
    throw error;
  }
}

/** A recovered process is observation-only: this handle cannot signal it. */
export async function recoverOpenCodeSharedHost(db: Db, binding: OpenCodeSharedBinding) {
  const { host, password } = await readOpenCodeHost(db, binding);
  const isAlive = () => { try { process.kill(host.pid, 0); return true; } catch { return false; } };
  const boundFetch = createOpenCodeBoundFetch({ pid: host.pid, port: host.port, isAlive });
  const origin = `http://127.0.0.1:${host.port}`;
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  async function attest() {
    const startedAt = await readProcessStartedAt(host.pid);
    if (!startedAt || startedAt !== host.startedAt) throw new Error("opencode_recovery_process_changed");
    const [command, cwd] = await Promise.all([
      execute("/bin/ps", ["-p", String(host.pid), "-o", "comm="], { timeout: 3000, maxBuffer: 4096 }),
      execute("/usr/sbin/lsof", ["-nP", "-a", "-p", String(host.pid), "-d", "cwd", "-Fn"], { timeout: 3000, maxBuffer: 4096 }),
    ]);
    if (command.stdout.trim() !== host.executable || !cwd.stdout.split("\n").includes(`n${host.workingDirectory ?? join(host.namespace, "work")}`)) throw new Error("opencode_recovery_process_changed");
    const response = await boundFetch(`${origin}/api/info`, { headers: { authorization }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("opencode_recovery_auth_failed");
    const info = await response.json() as { pid?: unknown; version?: unknown };
    if (info.pid !== host.pid || info.version !== "2.2.5") throw new Error("opencode_recovery_process_changed");
    const after = await readProcessStartedAt(host.pid);
    if (!after || after !== host.startedAt) throw new Error("opencode_recovery_process_changed");
  }
  await attest();
  const observer = createOpenCodeSharedObserver(db, { binding, fetch: boundFetch, admission: { baseUrl: origin, authorization,
    async attest(identity) { if (identity.sessionId !== binding.providerSessionId || identity.generation !== host.generation || identity.version !== "2.2.5") throw new Error("opencode_host_binding_mismatch"); await attest(); },
  } });
  return Object.freeze({
    async observe(signal?: AbortSignal) { await observer.observe(signal); },
    async verifySessionAndCatalog(proxy: { baseURL: string; token: string }) {
      await attest();
      const response = await boundFetch(`${origin}/api/session/${encodeURIComponent(binding.providerSessionId)}`, { headers: { authorization }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("opencode_session_unavailable");
      const body = await response.json() as { data?: { id?: unknown; location?: { directory?: unknown } } };
      if (body.data?.id !== binding.providerSessionId || body.data.location?.directory !== (host.workingDirectory ?? join(host.namespace, "work"))) throw new Error("opencode_session_mismatch");
      assertSessionModel(body.data, binding);
      await verifyOpenCodeNativeCatalog({ fetch: boundFetch, origin, authorization, directory: host.workingDirectory ?? join(host.namespace, "work"), model: binding.model, effort: binding.effort, providerBaseURL: proxy.baseURL, providerToken: proxy.token });
      await attest();
    },
    async replaceMcp(bridge: { url: string; secret: string }) {
      const target = new URL(bridge.url);
      if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port || target.pathname !== "/mcp" || target.search || target.hash || target.username || target.password || !/^[A-Za-z0-9_-]{43}$/.test(bridge.secret)) throw new Error("opencode_mcp_restoration_invalid");
      await readOpenCodeHostRestoration(db, binding);
      await attest();
      const directory = host.workingDirectory ?? join(host.namespace, "work");
      const body = JSON.stringify({ config: { type: "remote", url: bridge.url, headers: { Authorization: `Bearer ${bridge.secret}` }, oauth: false, codemode: false } });
      const digest = nativeSha256({ body });
      await reserveOpenCodeMcpRestoration(db, binding, digest);
      const send = createOpenCodeBoundFetch({ pid: host.pid, port: host.port, isAlive, allowExactMcpReplace: { body, directory } });
      await deliverOpenCodeMcpRestoration(db, binding, digest, async () => {
        const response = await send(`${origin}/api/experimental/mcp/paperclip?directory=${encodeURIComponent(directory)}`, { method: "PUT", headers: { authorization, "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) });
        if (response.status !== 204) throw new Error("opencode_mcp_restoration_outcome_unknown");
        const listing = await boundFetch(`${origin}/api/mcp?directory=${encodeURIComponent(directory)}`, { headers: { authorization }, signal: AbortSignal.timeout(3_000) });
        if (!listing.ok || !listing.body || Number(listing.headers.get("content-length") ?? 0) > 1_048_576) throw new Error("opencode_mcp_restoration_outcome_unknown");
        const reader = listing.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1_048_576) { await reader.cancel(); throw new Error("opencode_mcp_restoration_outcome_unknown"); } chunks.push(part.value); } }
        finally { reader.releaseLock(); }
        let payload: { data?: Array<{ name?: unknown; status?: { status?: unknown } }> };
        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("opencode_mcp_restoration_outcome_unknown"); }
        const matches = Array.isArray(payload.data) ? payload.data.filter(item => item.name === "paperclip") : [];
        if (matches.length !== 1 || matches[0]?.status?.status !== "connected") throw new Error("opencode_mcp_restoration_outcome_unknown");
      });
      await attest();
    },
  });
}
