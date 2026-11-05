import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRules, plan } from "./hot-deploy.mjs";

const rules = parseRules(`
hot server/src/adapters/claude-rc/execute.ts
hot-glob server/src/adapters/claude-rc/*.ts
none-prefix doc/
none-suffix .md
`);

describe("deploy impact", () => {
  it("skips identical builds and documentation-only changes", () => {
    assert.equal(plan([], rules), "none");
    assert.equal(plan(["doc/guide.txt", "README.md"], rules), "none");
  });
  it("keeps adapter updates hot but replaces for any other runtime change", () => {
    assert.equal(plan(["doc/guide.txt", "server/src/adapters/claude-rc/execute.ts"], rules), "hot");
    assert.equal(plan(["server/src/adapters/claude-rc/execute.ts", "server/src/index.ts"], rules), "full");
    assert.equal(plan(["server/src/adapters/claude-rc/nested/worker.ts"], rules), "full");
  });
});
