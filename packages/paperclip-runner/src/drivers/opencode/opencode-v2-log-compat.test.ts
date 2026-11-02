import { expect, it } from "vitest";
import { parseOpenCodeSseFrames } from "./sse-frames.js";

// v2.2.5 protocol session.log and schema/event-log.ts: durable envelope and
// replay-to-live synchronization marker, both carried as SSE data JSON.
it("preserves v2 durable log envelopes and the replay watermark across fragmented SSE", async () => {
  const items = [
    { id: "evt_fixture", type: "session.execution.succeeded", created: 1, durable: { aggregateID: "ses_fixture", seq: 3, version: 1 }, data: { sessionID: "ses_fixture" } },
    { type: "log.synced", aggregateID: "ses_fixture", seq: 3 },
  ];
  const bytes = new TextEncoder().encode(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(""));
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7));
      controller.close();
    },
  });
  const received: unknown[] = [];
  for await (const frame of parseOpenCodeSseFrames(input)) {
    expect(frame.compaction).toBeUndefined();
    received.push(JSON.parse(frame.data));
  }
  expect(received).toEqual(items);
});
