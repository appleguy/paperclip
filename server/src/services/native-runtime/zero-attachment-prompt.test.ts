import { describe, expect, it } from "vitest";
import { renderNativeRunnerStagedAttachmentPrompt } from "./native-runner-file-handoff.js";

describe("staged attachment prompt", () => {
  it("preserves descriptors without guidance in zero mode", () => {
    const attachment = { id: "a", filename: "note.txt", contentType: "text/plain", byteSize: 3, workspaceRelativePath: ".inbound/note.txt", unavailableReason: null };
    expect(renderNativeRunnerStagedAttachmentPrompt([attachment], true)).toBe(`Attachments:\n- ${JSON.stringify(attachment)}`);
    expect(renderNativeRunnerStagedAttachmentPrompt([attachment])).toContain("Paperclip native attachment access:");
    expect(renderNativeRunnerStagedAttachmentPrompt([], true)).toBe("");
  });
});
