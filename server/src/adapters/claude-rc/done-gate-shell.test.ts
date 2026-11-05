import { describe, expect, it } from "vitest";
import { nonmutatingShell, opaqueWriterOf } from "./done-gate-shell.js";

describe("nonmutating shell contract", () => {
  it("recognizes the slot proof and simple foreground commands", () => {
    for (const command of ['sleep 120; echo "TMUX=$TMUX"', "sleep 120\necho $TMUX", "pwd && echo 'done'", "/bin/sleep 1", "echo ok | /bin/echo done"])
      expect(nonmutatingShell(command), command).toBe(true);
  });
  it("never infers a command's effects from its name appearing in shell text", () => {
    for (const command of [undefined, "", "sleep 1 &", "echo x > own.ts", "echo x >> own.ts", "echo $(touch own.ts)",
      'echo "$(touch own.ts)"', "echo `touch own.ts`", "echo $((x++))", 'echo "${x:=value}"',
      "sleep 1; touch own.ts", "echo x\ntouch own.ts", "echo x | tee own.ts", "echo x\\\ntouch own.ts",
      "eval 'echo x'", "sh -c 'sleep 1'", "git diff --output=own.ts", "function echo() { touch own.ts; }; echo x"])
      expect(nonmutatingShell(command), String(command)).toBe(false);
  });
});

describe("opaque tool attribution (SCO-1003)", () => {
  const abs = "/repo/server/src/own.ts", rel = "server/src/own.ts";
  const bash = (text: string) => opaqueWriterOf([{ tool: "Bash", text }], abs, rel);
  it("does not claim files that shell commands only read", () => {
    for (const text of ["rg -n 'a|b' server/src/own.ts 2>&1 | head", "git -C /repo diff -- server/src/own.ts", "cat /repo/server/src/own.ts > /dev/null",
      "sed -n 1,20p server/src/own.ts", "find server -name own.ts", "git log --oneline -3 -- own.ts",
      "cat > /tmp/comment.md <<'EOF'\nsee server/src/own.ts\nEOF", "touch server/src/own.ts.bak", "echo data.own.ts"])
      expect(bash(text), text).toBe(false);
  });
  it("claims files a writing segment names", () => {
    for (const text of ["echo x > server/src/own.ts", "sed -i '' s/a/b/ own.ts", "cd server/src && perl -pi -e s/a/b/ own.ts",
      "jq . a.json > /tmp/t && mv /tmp/t /repo/server/src/own.ts", "echo $(touch own.ts)", "git checkout -- server/src/own.ts",
      "rg -l x | xargs sed -i s/a/b/ own.ts", "printf x | tee src/own.ts"])
      expect(bash(text), text).toBe(true);
  });
  it("claims files only when another opaque tool's input value is the path", () => {
    expect(opaqueWriterOf([{ tool: "mcp__dc__write_file", text: JSON.stringify({ path: abs, content: "x" }) }], abs, rel)).toBe(true);
    expect(opaqueWriterOf([{ tool: "mcp__paperclip__comment", text: JSON.stringify({ body: `edited ${rel} today` }) }], abs, rel)).toBe(false);
  });
});
