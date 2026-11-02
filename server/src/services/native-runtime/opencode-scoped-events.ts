/** Project only event types whose native 2.2.5 envelopes have been verified.
 * This stream is volatile: reconnect never asserts replay or durable coverage. */
export function scopedOpenCodeEvents(upstream: ReadableStream<Uint8Array>, sessionId: string, directory: string, attest: () => Promise<void>): ReadableStream<Uint8Array> {
  const reader = upstream.getReader(), decoder = new TextDecoder(), encoder = new TextEncoder();
  let buffer = "";
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const lines = frame.split("\n").filter(line => line.startsWith("data:"));
            if (lines.length !== 1) continue;
            let value: any; try { value = JSON.parse(lines[0]!.slice(5)); } catch { continue; }
            if (value?.type === "server.connected" && typeof value.id === "string" && value.id.length <= 256 && value.data && typeof value.data === "object" && !Array.isArray(value.data) && Object.keys(value.data).length === 0) {
              await attest(); controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: value.id, type: "server.connected", data: {} })}\n\n`)); return;
            }
            if (!value || typeof value !== "object" || typeof value.id !== "string" || value.id.length > 256 || !Number.isFinite(value.created) || !value.data || typeof value.data !== "object" || value.data.sessionID !== sessionId) continue;
            let data: Record<string, unknown>;
            if (value.type === "session.renamed" && typeof value.data.title === "string" && value.data.title.length <= 4096) data = { sessionID: sessionId, title: value.data.title };
            else if (value.type === "session.created" && value.location?.directory === directory && value.data.location?.directory === directory && ["slug", "version", "projectID", "subpath"].every(key => typeof value.data[key] === "string" && value.data[key].length <= 4096)) data = { sessionID: sessionId, slug: value.data.slug, version: value.data.version, projectID: value.data.projectID, subpath: value.data.subpath, location: { directory } };
            else continue;
            await attest();
            const projected = { id: value.id, created: value.created, type: value.type, ...(value.type === "session.created" ? { location: { directory } } : {}), data };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(projected)}\n\n`)); return;
          }
          const part = await reader.read();
          if (part.done) { controller.close(); return; }
          buffer = (buffer + decoder.decode(part.value, { stream: true })).replaceAll("\r\n", "\n");
          if (buffer.length > 262144) throw new Error("opencode_event_frame_too_large");
        }
      } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
    },
    async cancel() { await reader.cancel().catch(() => {}); },
  });
}
