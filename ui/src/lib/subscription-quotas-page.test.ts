// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(resolve(process.cwd(), "ui/public/subscription-quotas.html"), "utf8");
const script = html.split("<script>")[1]?.split("</script>")[0];
const body = html.split("<body>")[1]?.split("<script>")[0];

describe("standalone subscription quotas", () => {
  beforeEach(() => {
    expect(script).toBeTruthy();
    expect(body).toBeTruthy();
    document.body.innerHTML = body!;
    vi.spyOn(window, "setInterval").mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows all providers through the authenticated company ID, including unknown and true zero", async () => {
    const calls: string[] = [];
    const data = {
      source: "quota-sentinel", observedAt: "2026-10-31T03:39:37Z", stale: false,
      pools: [
        { provider: "antigravity", pool: "3p:weekly", usedPercent: 76.85, resetsAt: "2026-11-04T04:14:42Z", state: "behind_pace" },
        { provider: "codex", pool: "weekly", usedPercent: 18, resetsAt: "2026-11-05T10:04:17Z", state: "behind_pace" },
        { provider: "claude", pool: "weekly", usedPercent: 0, resetsAt: "2026-11-06T11:00:00Z", state: "need_trend" },
        { provider: "claude", pool: "session", usedPercent: null, resetsAt: null, state: "unknown" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async (path: string, opts: RequestInit) => {
      calls.push(path);
      expect(opts.credentials).toBe("same-origin");
      expect(opts.cache).toBe("no-store");
      return { ok: true, json: async () => path === "/api/companies" ? [{ id: "company-123", issuePrefix: "SCO" }] : path.endsWith("/history") ? { series: [{ provider: "codex", pool: "weekly", points: [{ t: new Date(Date.now() - 7200000).toISOString(), usedPercent: 10, resetsAt: new Date(Date.now() + 86400000).toISOString() }, { t: new Date(Date.now() - 3600000).toISOString(), usedPercent: 12, resetsAt: new Date(Date.now() + 86400000).toISOString() }] }] } : data };
    }));
    new Function(script!)();
    await vi.waitFor(() => expect(document.querySelectorAll("#charts section")).toHaveLength(4));
    expect(calls).toEqual(["/api/companies", "/api/companies/company-123/costs/quota-sentinel", "/api/companies/company-123/costs/quota-sentinel/history"]);
    expect(document.body.textContent).toContain("Third-party · weekly");
    expect(document.body.textContent).toContain("76.8% used");
    expect(document.body.textContent).toContain("recent rate below goal");
    expect(document.body.textContent).not.toContain("behind pace");
    expect(document.body.textContent).toContain("Nov 3, 2026");
    expect(document.body.textContent).toContain("ChatGPT / Codex");
    expect(document.body.textContent).toContain("Claude");
    expect(document.body.textContent).toContain("Unknown");
    expect(document.body.textContent).toContain("0.0% used");
    expect(document.querySelectorAll("#charts svg")).toHaveLength(1);
  });

  it("shows sign-in guidance rather than reporting zero usage for an unauthenticated user", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));
    new Function(script!)();
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toContain("Sign in"));
    expect(document.body.textContent).toContain("cannot be displayed");
    expect(document.body.textContent).not.toContain("0.0% used");
  });
});

describe("quota projection", () => {
  const source = script!.slice(script!.indexOf("function resetBetween"), script!.indexOf("function renderCharts"));
  const project = new Function("isShort", `${source}; return projection`)((item: { pool: string }) => item.pool === "session");
  const now = Date.parse("2026-11-05T12:00:00Z");
  const point = (hoursAgo: number, usedPercent: number, resetsAt = "2026-11-06T12:00:00Z") => ({ t: new Date(now - hoursAgo * 3600000).toISOString(), usedPercent, resetsAt });
  const item = { pool: "weekly", usedPercent: 40, resetsAt: "2026-11-06T12:00:00Z" };
  it("projects flat and rising usage", () => {
    expect(project([point(2, 40), point(1, 40)], item, now).projected).toBe(40);
    expect(project([point(2, 30), point(1, 35)], item, now).projected).toBe(160);
  });
  it("reports exhaustion only before reset", () => {
    expect(project([point(2, 30), point(1, 35)], item, now).exhaustion).toBe(now + 12 * 3600000);
    expect(project([point(2, 39), point(1, 40)], item, now).exhaustion).toBeNull();
  });
  it("excludes earlier reset periods", () => {
    const points = [point(4, 90, "2026-11-05T09:30:00Z"), point(3, 10), point(2, 12), point(1, 14)];
    expect(project(points, item, now).rate).toBe(2);
  });
});
