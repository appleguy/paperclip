#!/usr/bin/env node
'use strict';
// Channel MCP server (stdio JSON-RPC). Env: PC_BRIDGE_DIR, PC_BRIDGE_SERVER (default pcbridge).
const { Ledger, processInbox, decidePermission } = require('./lib/bridge.cjs');

const DIR = process.env.PC_BRIDGE_DIR;
if (!DIR) { process.stderr.write('PC_BRIDGE_DIR required\n'); process.exit(2); }
const NAME = process.env.PC_BRIDGE_SERVER || 'pcbridge';
const ledger = new Ledger(DIR);
const send = (m) => new Promise((res) => process.stdout.write(JSON.stringify(m) + '\n', () => res()));

const held = ledger.recover();
ledger.record({ ev: 'bridge_start', server: NAME, held_unknown_effect: held });

const TOOLS = [
  { name: 'paperclip_finish', description: 'Report that the Paperclip op identified by op_id is complete. Call exactly once per op.',
    inputSchema: { type: 'object', properties: { op_id: { type: 'string' }, summary: { type: 'string' } }, required: ['op_id', 'summary'] } },
  { name: 'paperclip_block', description: 'Report that the Paperclip op identified by op_id is blocked and cannot be completed.',
    inputSchema: { type: 'object', properties: { op_id: { type: 'string' }, reason: { type: 'string' } }, required: ['op_id', 'reason'] } },
];

let initialized = false;
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { try { handle(JSON.parse(line)); } catch (e) { ledger.record({ ev: 'server_error', error: String(e) }); } }
  }
});
process.stdin.on('end', () => { ledger.record({ ev: 'bridge_stop', reason: 'stdin_closed' }); process.exit(0); });

function toolResult(id, obj, isError = false) {
  return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(obj) }], isError } });
}

function handle(m) {
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,
      capabilities: { tools: {}, experimental: { 'claude/channel': {}, 'claude/channel/permission': {} } },
      serverInfo: { name: NAME, version: '0.1.0' },
      instructions: `Messages from Paperclip arrive as <channel source="${NAME}" op_id="...">. Do what the message asks. When finished call paperclip_finish with that op_id and a short summary; if you cannot complete it call paperclip_block with op_id and reason. Never call either tool for an op_id you were not given in a channel message. If a needed tool is denied, stop and do nothing else.` } });
  } else if (m.method === 'notifications/initialized') {
    initialized = true;
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
  } else if (m.method === 'tools/call') {
    const { name, arguments: a = {} } = m.params;
    if (name !== 'paperclip_finish' && name !== 'paperclip_block') return toolResult(m.id, { error: 'unknown_tool' }, true);
    const kind = name === 'paperclip_finish' ? 'finish' : 'block';
    const r = ledger.terminal(String(a.op_id), kind, kind === 'finish' ? { summary: String(a.summary || '') } : { reason: String(a.reason || '') });
    toolResult(m.id, r, !r.ok);
  } else if (m.method === 'notifications/claude/channel/permission_request') {
    const p = m.params || {};
    const d = decidePermission(ledger, p);
    send({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission', params: { request_id: p.request_id, behavior: d.behavior } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, result: {} }); // server/discover etc: same lenient behaviour as the probe
  }
}

let busy = false;
setInterval(async () => {
  if (!initialized || busy) return;
  busy = true;
  try {
    await processInbox(ledger, (opId, content) =>
      send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content, meta: { op_id: opId } } }));
  } catch (e) { ledger.record({ ev: 'server_error', error: String(e) }); }
  busy = false;
}, 500);
