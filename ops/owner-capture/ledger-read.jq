# JSONL is framed by lines, never by concatenating session files. Invalid bytes
# remain in the original ledger; one synthetic open record represents uncertainty.
def event:
  type == "object" and (.id | type == "string") and (.id | length > 0)
  and (if .ts == null then .text == null
       else (.ts | type == "string")
         and (try (.ts | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 | type == "number") catch false) end)
  and (all(.text, .sid, .cwd, .proc, .src, .adopt, .close, .reopen,
           .escalated, .watch, .unwatch; . == null or type == "string"))
  and (if .text != null then (.sid | type == "string") else true end);
reduce inputs as $line ({records: [], bad: 0, first: 0, n: 0};
  .n += 1
  | (try ($line | fromjson | if event then del(._ledger_unknown)
          | if .ts != null then .ts |= sub("\\.[0-9]+Z$"; "Z") else . end
        else null end) catch null) as $r
  | if $r == null then
      .bad += 1 | if .first == 0 then .first = .n else . end
    else .records += [$r] end)
| .records[],
  (select(.bad > 0)
   | ("owner-guard: corrupt ledger \($sid|.[0:80]) line \(.first) (\(.bad) invalid line(s)); original bytes retained; state unknown\n" | stderr | empty),
     {id: ("__ledger_unknown__:" + $sid), sid: $sid,
      ts: "1970-01-01T00:00:00Z", cwd: "", proc: "", src: "ledger-corruption",
      text: "Ledger has unreadable records; owner state is unknown. Repair the original ledger before clearing this warning.",
      _ledger_unknown: true})
