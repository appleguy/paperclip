/** Resolve only an explicitly configured server-side provider. Discovery is a
 * bounded metadata read; it never starts or reloads a model. */
export async function resolveOpenCodeSharedProvider(input: { model: string; environment: NodeJS.ProcessEnv; fetch?: typeof fetch }) {
  const slash = input.model.indexOf("/");
  const provider = input.model.slice(0, slash), model = input.model.slice(slash + 1);
  if (slash <= 0 || !model || !["paperclip", "openrouter"].includes(provider)) throw new Error("opencode_provider_profile_unsupported");
  const base = provider === "openrouter" ? "https://openrouter.ai/api/v1" : input.environment.PAPERCLIP_AI_PROVIDER_URL;
  const key = provider === "openrouter" ? input.environment.OPENROUTER_API_KEY : input.environment.PAPERCLIP_AI_PROVIDER_KEY;
  if (!base || !key) throw new Error("opencode_provider_account_missing");
  const url = new URL(base);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error("opencode_provider_endpoint_invalid");
  const response = await (input.fetch ?? fetch)(`${base.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("application/json")) throw new Error("opencode_provider_discovery_failed");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1_048_576) { await reader.cancel(); throw new Error("opencode_provider_discovery_oversized"); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("opencode_provider_discovery_invalid"); }
  const items = data && typeof data === "object" && !Array.isArray(data) ? (data as { data?: unknown }).data : null;
  if (!Array.isArray(items) || items.filter(item => item && typeof item === "object" && !Array.isArray(item) && (item as { id?: unknown }).id === model).length !== 1) throw new Error("opencode_provider_model_unavailable");
  return Object.freeze({ provider, model, baseUrl: base, key });
}
