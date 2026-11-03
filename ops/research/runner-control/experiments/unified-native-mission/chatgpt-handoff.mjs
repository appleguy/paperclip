#!/usr/bin/env node
// ChatGPT Web manual Chat-mode handoff/import for one Paperclip issue (spec D6/N1: outside the runtime).
//   export ISSUE_ID [--ttl-min 360]          -> new handoff id, packet text on stdout (supersedes older handoffs)
//   import ISSUE_ID REPLY_FILE --origin URL  -> accept once, or reject duplicate / stale / wrong-origin
// The ledger lives on the issue itself (document key "chatgpt-handoff"), so Paperclip stays the record.
// Pure checks are exported for tests; no secrets are read or printed here.
import crypto from "node:crypto";
import fs from "node:fs/promises";

export const MARKER_RE = /PAPERCLIP-HANDOFF ([0-9a-f-]{36}) ([A-Z]+-\d+)/g;
export const ORIGIN_RE = /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]{20,}$/;

/** Decide whether a reply may be imported. Returns {ok, reason, handoff}. */
export function checkImport(ledger, issue, reply, origin, now = Date.now()) {
  if (!ORIGIN_RE.test(origin ?? "")) return { ok: false, reason: "wrong-origin: not a chatgpt.com Chat-mode conversation URL" };
  const markers = [...reply.matchAll(MARKER_RE)];
  if (markers.length !== 1) return { ok: false, reason: `wrong-origin: expected exactly one handoff marker, found ${markers.length}` };
  const [, id, ident] = markers[0];
  if (ident !== issue.identifier) return { ok: false, reason: `wrong-origin: marker names ${ident}, not ${issue.identifier}` };
  const h = ledger.handoffs.find((x) => x.id === id);
  if (!h) return { ok: false, reason: "wrong-origin: handoff id was never exported for this issue" };
  const sha = crypto.createHash("sha256").update(reply).digest("hex");
  if (h.status === "imported" || ledger.handoffs.some((x) => x.replySha256 === sha))
    return { ok: false, reason: `duplicate: handoff ${id} already imported` };
  if (h.status === "superseded") return { ok: false, reason: `stale: handoff ${id} superseded by a newer export` };
  if (Date.parse(h.expiresAt) < now) return { ok: false, reason: `stale: handoff ${id} expired at ${h.expiresAt}` };
  if (h.origin && h.origin !== origin) return { ok: false, reason: "wrong-origin: handoff bound to a different conversation" };
  return { ok: true, reason: "accepted", handoff: h, sha };
}

export function newHandoff(ledger, issue, ttlMin, now = Date.now()) {
  for (const h of ledger.handoffs) if (h.status === "open") h.status = "superseded";
  const h = { id: crypto.randomUUID(), status: "open", createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMin * 60_000).toISOString() };
  ledger.handoffs.push(h);
  return h;
}

export function packet(issue, h) {
  return [
    `Paperclip issue ${issue.identifier}: ${issue.title}`, "", issue.description ?? "", "",
    "Answer in this chat. End your reply with this exact line, unchanged, on its own:",
    `PAPERCLIP-HANDOFF ${h.id} ${issue.identifier}`,
  ].join("\n");
}

const fence = "```";
const render = (l) => `ChatGPT Web manual handoff ledger (managed by chatgpt-handoff.mjs).\n\n${fence}json\n${JSON.stringify(l, null, 2)}\n${fence}\n`;
const parse = (body) => {
  const m = /```json\n([\s\S]*?)\n```/.exec(body ?? "");
  return m ? JSON.parse(m[1]) : { handoffs: [] };
};

async function main() {
  const { makeClient } = await import("./deploy-drain.mjs");
  const [cmd, issueId, file] = process.argv.slice(2);
  const opt = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const client = await makeClient();
  const issue = await client.api("GET", `/api/issues/${issueId}`);
  const doc = await client.api("GET", `/api/issues/${issueId}/documents/chatgpt-handoff`).catch(() => null);
  const ledger = parse(doc?.body);
  const save = (summary) => client.api("PUT", `/api/issues/${issueId}/documents/chatgpt-handoff`, {
    title: "ChatGPT Web handoff ledger", format: "markdown", body: render(ledger), changeSummary: summary,
    ...(doc?.latestRevisionId ? { baseRevisionId: doc.latestRevisionId } : {}),
  });
  if (cmd === "export") {
    const h = newHandoff(ledger, issue, Number(opt("--ttl-min", "360")));
    await save(`export ${h.id}`);
    process.stdout.write(packet(issue, h) + "\n");
    console.error(`handoff ${h.id} open until ${h.expiresAt}`);
  } else if (cmd === "import") {
    const reply = await fs.readFile(file, "utf8");
    const origin = opt("--origin", "");
    const v = checkImport(ledger, issue, reply, origin);
    if (!v.ok) {
      ledger.rejections = [...(ledger.rejections ?? []), { at: new Date().toISOString(), origin, reason: v.reason }].slice(-20);
      await save(`reject: ${v.reason}`);
      console.log(JSON.stringify({ accepted: false, reason: v.reason }));
      process.exit(3);
    }
    Object.assign(v.handoff, { status: "imported", importedAt: new Date().toISOString(), origin, replySha256: v.sha });
    await client.api("PUT", `/api/issues/${issueId}/documents/chatgpt-reply`, {
      title: `ChatGPT Web reply (handoff ${v.handoff.id})`, format: "markdown",
      body: `Origin: ${origin}\nHandoff: ${v.handoff.id}\nsha256: ${v.sha}\n\n${reply}`,
      changeSummary: `import handoff ${v.handoff.id}`,
    });
    await save(`import ${v.handoff.id}`);
    console.log(JSON.stringify({ accepted: true, handoff: v.handoff.id, sha256: v.sha }));
  } else {
    console.error("usage: chatgpt-handoff.mjs export ISSUE_ID [--ttl-min N] | import ISSUE_ID REPLY_FILE --origin URL");
    process.exit(2);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
