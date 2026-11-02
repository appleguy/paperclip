/** Validate the effective catalog reported by the attested native server.
 * Provider and model discovery are metadata-only; no prompt is sent. */
export async function verifyOpenCodeNativeCatalog(input: { fetch: typeof fetch; origin: string; authorization: string; directory: string; model: string; effort: string; providerBaseURL: string; providerToken: string }) {
  const slash = input.model.indexOf("/");
  if (slash <= 0 || slash === input.model.length - 1 || !input.effort) throw new Error("opencode_native_catalog_identity_invalid");
  const provider = input.model.slice(0, slash), model = input.model.slice(slash + 1);
  const query = `?directory=${encodeURIComponent(input.directory)}`;
  async function read(path: string) {
    const response = await input.fetch(`${input.origin}${path}${query}`, { headers: { authorization: input.authorization }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !response.body) throw new Error("opencode_native_catalog_unavailable");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1_048_576) { await reader.cancel(); throw new Error("opencode_native_catalog_oversized"); } chunks.push(part.value); } }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: unknown }; } catch { throw new Error("opencode_native_catalog_invalid"); }
  }
  await read("/api/provider"); // Initializes the native provider registry.
  const entry = (await read(`/api/provider/${encodeURIComponent(provider)}`)).data;
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || (entry as { id?: unknown }).id !== provider || (entry as { package?: unknown }).package !== "@opencode/ai/providers/openai-compatible") throw new Error("opencode_native_provider_unavailable");
  const settings = (entry as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || (settings as { baseURL?: unknown }).baseURL !== input.providerBaseURL || (settings as { apiKey?: unknown }).apiKey !== input.providerToken) throw new Error("opencode_native_provider_binding_mismatch");
  const data = (await read("/api/model")).data;
  const matches = Array.isArray(data) ? data.filter(item => item && typeof item === "object" && !Array.isArray(item) && item.id === model && item.providerID === provider) : [];
  if (matches.length !== 1) throw new Error("opencode_native_model_unavailable");
  const variants = matches[0].variants;
  if (!Array.isArray(variants) || variants.filter(item => item && typeof item === "object" && !Array.isArray(item) && item.id === input.effort).length !== 1) throw new Error("opencode_native_variant_unavailable");
}
