import { describe, expect, it } from "vitest";
import { modelUsage, parseModelRequest } from "./model-invocation-contract.js";

const request = {
  family: "luna", role: "author", authorFamily: "luna", prompt: "Generate a record",
  workingDirectory: "/work", schemaPath: "/work/schema.json", responsePath: "/work/response.json",
  freshContext: true, toolsDisabled: true,
};

describe("model invocation boundary", () => {
  it("accepts a cross-family critic and rejects self critique", () => {
    expect(parseModelRequest({ ...request, family: "sonnet", role: "critic" }).role).toBe("critic");
    expect(() => parseModelRequest({ ...request, role: "critic" })).toThrow("self-family");
  });
  it.each([
    { freshContext: false }, { toolsDisabled: false }, { workingDirectory: "relative" },
    { schemaPath: "" }, { responsePath: "relative" }, { family: "other" },
    { role: "author", authorFamily: "sonnet" }, { prompt: " " },
  ])("rejects an invalid request before dispatch: %j", (patch) => {
    expect(() => parseModelRequest({ ...request, ...patch })).toThrow();
  });
  it("distinguishes missing and invalid usage from reported zeros", () => {
    expect(modelUsage(undefined, undefined).known).toBe(false);
    expect(modelUsage(-1, 2).known).toBe(false);
    expect(modelUsage(Number.MAX_SAFE_INTEGER, 1).known).toBe(false);
    expect(modelUsage(0, 0)).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0, known: true });
    expect(modelUsage(12, 3)).toEqual({ input_tokens: 12, output_tokens: 3, total_tokens: 15, known: true });
  });
});
