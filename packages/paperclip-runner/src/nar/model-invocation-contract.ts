// Validation for the Tensor64 one-shot boundary. This is not a provider
// transport: callers must still establish fresh context and disable tools at
// the provider before sending anything.
import { isAbsolute } from "node:path";

export type ModelFamily = "luna" | "sonnet";
export type ModelRole = "author" | "critic";

export interface ModelRequest {
  family: ModelFamily;
  role: ModelRole;
  authorFamily: ModelFamily;
  prompt: string;
  workingDirectory: string;
  schemaPath: string;
  responsePath: string;
  freshContext: true;
  toolsDisabled: true;
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  known: boolean;
}

export interface ModelResult {
  family: ModelFamily;
  role: ModelRole;
  response: string;
  usage: ModelUsage;
  wall_nanos: number;
}

/** Validate untrusted request data before a conversation is created. */
export function parseModelRequest(value: unknown): ModelRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("model request must be an object");
  }
  const r = value as Record<string, unknown>;
  const family = (v: unknown): v is ModelFamily => v === "luna" || v === "sonnet";
  if (!family(r.family) || !family(r.authorFamily)) throw new Error("unsupported model family");
  if (r.role !== "author" && r.role !== "critic") throw new Error("unsupported model role");
  if (r.role === "author" && r.family !== r.authorFamily) throw new Error("author family mismatch");
  if (r.role === "critic" && r.family === r.authorFamily) throw new Error("self-family critic prohibited");
  if (r.freshContext !== true || r.toolsDisabled !== true) throw new Error("fresh context and disabled tools are required");
  if (typeof r.prompt !== "string" || !r.prompt.trim()) throw new Error("prompt is required");
  for (const key of ["workingDirectory", "schemaPath", "responsePath"] as const) {
    if (typeof r[key] !== "string" || !isAbsolute(r[key] as string)) throw new Error(`${key} must be an absolute path`);
  }
  return r as unknown as ModelRequest;
}

/** Keep absent accounting explicitly unknown instead of inventing zero usage. */
export function modelUsage(input: unknown, output: unknown): ModelUsage {
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || Number(input) < 0 || Number(output) < 0 || !Number.isSafeInteger(Number(input) + Number(output))) {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0, known: false };
  }
  return { input_tokens: Number(input), output_tokens: Number(output), total_tokens: Number(input) + Number(output), known: true };
}
