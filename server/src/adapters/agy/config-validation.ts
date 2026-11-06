import { AGY_MODELS } from "./execute.js";
import path from "node:path";
import { unprocessable } from "../../errors.js";

export function validateConfig(config: Record<string, unknown>): void {
  if (config.model !== undefined && !(AGY_MODELS as readonly unknown[]).includes(config.model)) {
    throw unprocessable(`Invalid agy_local adapterConfig.model: permits only ${AGY_MODELS.join(", ")}`);
  }
  // Antigravity encodes effort in the model id; a separate field is ignored at runtime.
  if (config.effort !== undefined) {
    throw unprocessable("Invalid agy_local adapterConfig.effort: select effort in the model id instead");
  }
  // Match execute's cwd restrictions without touching the shared execute module.
  if (typeof config.cwd === "string") {
    const cwd = path.resolve(config.cwd);
    if (cwd === "/" || cwd.startsWith("/private/var/folders") || cwd.startsWith("/var/folders")) {
      throw unprocessable(`Invalid agy_local adapterConfig.cwd: ${cwd} is root or system temp; use a canonical NVM path`);
    }
  }
}
