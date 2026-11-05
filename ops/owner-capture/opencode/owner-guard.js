// SCO-728: OpenCode (v2 plugin API) shim for the owner-steering ledger. All logic lives in ../owner-guard (see its header).
//   receipt: session context hook sees each new user text part -> `owner-guard capture` before the model does (OWNER_GUARD_SRC=opencode)
//   resume:  same hook appends `owner-guard resume` output to the system prompt, so open records survive compaction and restart
//   gate:    turn end (session.execution.succeeded) -> `owner-guard gate`; decision:block sends reason back once (stop_hook_active on the second idle)
// Paperclip adapter runs (PAPERCLIP_RUN_ID) are automated, never owner typing: the shim stays inert there. Never throws.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const G = "/Volumes/NVM/Paperclip/ops/owner-capture/owner-guard";
const seen = new Map(); // sessionID -> Set of user message ids already offered to capture
const reprompted = new Set(); // sessionIDs whose current stop cycle already got its one re-prompt
const dbg = (m) => { if (process.env.OWNER_GUARD_DEBUG) try { appendFileSync(process.env.OWNER_GUARD_DEBUG, m + "\n"); } catch {} };

function guard(cmd, payload) {
  try {
    const r = spawnSync(G, [cmd], {
      input: JSON.stringify(payload),
      timeout: 4000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      env: Object.assign({}, process.env, { OWNER_GUARD_SRC: "opencode" }),
    });
    return r.stdout || "";
  } catch {
    return ""; // a ledger failure must never stop the turn
  }
}

const userText = (m) => (m.content ?? []).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");

export default {
  id: "paperclip.owner-guard",
  setup(ctx) {
    if (process.env.PAPERCLIP_RUN_ID) return;
    const cwd = ctx.location?.directory ?? process.cwd();
    try {
      ctx.session.hook("context", (p) => {
        try {
          const sid = p.sessionID;
          if (!sid) return;
          const users = (p.messages ?? []).filter((m) => m.role === "user");
          const first = !seen.has(sid);
          const done = seen.get(sid) ?? new Set();
          seen.set(sid, done);
          // first sight of a session in this process: only the newest message is new; older ones were captured when typed
          const fresh = users.filter((m) => !done.has(m.id)).slice(first ? -1 : 0);
          for (const m of users) done.add(m.id);
          for (const m of fresh) {
            const prompt = userText(m);
            if (!prompt || /^\s*<(shell|tool_result|tool-result)\b/.test(prompt)) continue; // SCO-803: shell/tool output is not owner typing
            if (!prompt.startsWith("OWNER STEERING OPEN")) reprompted.delete(sid); // an owner message starts a new stop cycle (our own re-prompt does not)
            dbg("capture " + sid + " " + prompt.slice(0, 80));
            guard("capture", { session_id: sid, message_id: m.id, cwd, prompt });
          }
          const out = guard("resume", { session_id: sid, cwd }).trim();
          if (out) (p.system ??= []).push({ type: "text", text: out });
        } catch (e) { dbg("context err " + e); }
      });
      (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ types: ["session.execution.succeeded"] })) {
            try {
              const sid = ev?.data?.sessionID ?? ev?.properties?.sessionID ?? ev?.sessionID;
              dbg("event " + ev?.type + " " + sid);
              if (!sid) continue;
              const active = reprompted.has(sid);
              const out = guard("gate", { session_id: sid, stop_hook_active: active }).trim();
              if (!out) continue;
              const d = JSON.parse(out);
              if (d.decision === "block" && !active) {
                reprompted.add(sid);
                dbg("gate block " + sid);
                await ctx.session.prompt({ sessionID: sid, text: d.reason });
              }
            } catch (e) { dbg("gate err " + e); }
          }
        } catch (e) { dbg("subscribe err " + e); }
      })();
    } catch (e) { dbg("setup err " + e); }
  },
};
