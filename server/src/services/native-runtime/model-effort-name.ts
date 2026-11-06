type Harness = "codex" | "claude" | "agy";

const families: Record<Harness, Array<[RegExp, string]>> = {
  codex: [[/\bsol\b/i, "S"], [/\bterra\b/i, "T"], [/\bluna\b/i, "L"], [/\bastra\b/i, "A"]],
  claude: [[/\bopus\b/i, "O"], [/\bsonnet\b/i, "S"], [/\bhaiku\b/i, "H"], [/\bfable\b/i, "F"]],
  agy: [[/\bflash\b/i, "GF"], [/\bargon\b/i, "Ar"], [/\bopus\b/i, "O"], [/\bsonnet\b/i, "S"], [/\bhaiku\b/i, "H"], [/\bfable\b/i, "F"]],
};
const efforts: Record<string, string> = { low: "L", medium: "M", high: "H", xhigh: "X", max: "Mx" };

export function cleanDisplayName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, "[link]")
    .replace(/\b(?:bearer\s+\S+|(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+)/gi, "[redacted]")
    .replace(/\b(?:sk|ghp|github_pat)-[a-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/\s+/g, " ").trim();
}

export function modelEffortName(harness: Harness, model?: string | null, effort?: string | null): string {
  const family = families[harness].find(([pattern]) => pattern.test(model ?? ""))?.[1] ?? "";
  const level = efforts[(effort ?? "").toLowerCase()] ?? "";
  return family && level ? `${family}@${level}` : family || level;
}

export function stripModelEffortWords(name: string, harness: Harness, model?: string | null, effort?: string | null): string {
  const tag = modelEffortName(harness, model, effort);
  if (tag) name = name.replace(new RegExp(`(?:^|\\s)${tag}(?=\\s|$)`, "gi"), " ");
  const family = families[harness].find(([pattern]) => pattern.test(model ?? ""));
  if (family) name = name.replace(new RegExp(family[0].source, "gi"), " ");
  if (efforts[(effort ?? "").toLowerCase()]) name = name.replace(new RegExp(`\\b${effort}\\b`, "gi"), " ");
  return name.replace(/\s+/g, " ").trim();
}
