import test from "node:test";
import assert from "node:assert/strict";
import { checkImport, newHandoff, packet } from "./chatgpt-handoff.mjs";

const issue = { identifier: "SCO-1", title: "t", description: "d" };
const url = "https://chatgpt.com/c/6ae97379-ddf4-83e8-ba14-d1c0c14369a4";
const reply = (h, ident = "SCO-1") => `answer\nPAPERCLIP-HANDOFF ${h.id} ${ident}\n`;

test("accepts once, then rejects duplicate, stale and wrong-origin", () => {
  const ledger = { handoffs: [] };
  const h1 = newHandoff(ledger, issue, 60);
  const h2 = newHandoff(ledger, issue, 60);
  assert.equal(h1.status, "superseded");
  assert.match(packet(issue, h2), new RegExp(`PAPERCLIP-HANDOFF ${h2.id} SCO-1$`));
  assert.match(checkImport(ledger, issue, reply(h1), url).reason, /^stale/);
  assert.match(checkImport(ledger, issue, reply(h2), "https://evil.example/c/x").reason, /^wrong-origin/);
  assert.match(checkImport(ledger, issue, reply(h2, "SCO-2"), url).reason, /^wrong-origin/);
  assert.match(checkImport(ledger, issue, reply({ id: crypto.randomUUID() }), url).reason, /^wrong-origin/);
  assert.match(checkImport(ledger, issue, reply(h2) + reply(h2), url).reason, /^wrong-origin/);
  const ok = checkImport(ledger, issue, reply(h2), url);
  assert.equal(ok.ok, true);
  Object.assign(ok.handoff, { status: "imported", origin: url, replySha256: ok.sha });
  assert.match(checkImport(ledger, issue, reply(h2), url).reason, /^duplicate/);
});

test("expired handoff is stale", () => {
  const ledger = { handoffs: [] };
  const h = newHandoff(ledger, issue, 1, Date.now() - 120_000);
  assert.match(checkImport(ledger, issue, reply(h), url).reason, /^stale.*expired/);
});
