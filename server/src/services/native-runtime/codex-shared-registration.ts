export function resolveCodexSharedRegistration(env: NodeJS.ProcessEnv, agentId: string): {
  grantId: string;
  hostId: string;
  codexExecutable: string;
  codexHome: string;
  home: string;
} | null {
  let grantId: string | undefined;
  if (env.PAPERCLIP_CODEX_SHARED_GRANTS?.trim()) {
    let grants: unknown;
    try {
      grants = JSON.parse(env.PAPERCLIP_CODEX_SHARED_GRANTS);
    } catch {
      throw new Error("codex_shared_registration_unavailable");
    }
    if (!grants || typeof grants !== "object" || Array.isArray(grants)) {
      throw new Error("codex_shared_registration_unavailable");
    }
    const value = Object.prototype.hasOwnProperty.call(grants, agentId)
      ? (grants as Record<string, unknown>)[agentId] : undefined;
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error("codex_shared_registration_unavailable");
    }
    grantId = typeof value === "string" ? value.trim() : undefined;
  }
  if (!grantId && env.PAPERCLIP_CODEX_SHARED_AGENT_ID?.trim() === agentId) {
    grantId = env.PAPERCLIP_CODEX_SHARED_GRANT_ID?.trim();
    if (!grantId) throw new Error("codex_shared_registration_unavailable");
  }
  if (!grantId) return null;
  const hostId = env.PAPERCLIP_CODEX_SHARED_HOST_ID?.trim();
  const codexExecutable = env.PAPERCLIP_CODEX_SHARED_EXECUTABLE?.trim();
  const codexHome = env.PAPERCLIP_CODEX_SHARED_CODEX_HOME?.trim();
  const home = env.PAPERCLIP_CODEX_SHARED_HOME?.trim();
  if (!hostId || !codexExecutable || !codexHome || !home) {
    throw new Error("codex_shared_registration_unavailable");
  }
  return { grantId, hostId, codexExecutable, codexHome, home };
}
