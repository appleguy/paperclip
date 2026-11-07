// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(resolve(process.cwd(), existsSync("ui/public/subscription-quotas.html") ? "ui/public/subscription-quotas.html" : "public/subscription-quotas.html"), "utf8");
const script = html.split("<script>")[1]?.split("</script>")[0];
const body = html.split("<body>")[1]?.split("<script>")[0];
const HOUR = 3600000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const sample = (t: number, usedPercent: number, resetsAt: string | null) => ({ t: iso(t), usedPercent, resetsAt });
const windowRow = (provider: string, pool: string, usedPercent: number | null, resetsAt: string | null, quality?: string) => ({ provider, pool, usedPercent, resetsAt, quality });

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

  async function render(pools: ReturnType<typeof windowRow>[], series: unknown[] = [], options: { stale?: boolean; observedAt?: string; bankedReset?: unknown } = {}) {
    const calls: string[] = [];
    const data = { source: "quota-sentinel", observedAt: options.observedAt || iso(Date.now()), stale: !!options.stale, pools, bankedReset: options.bankedReset };
    vi.stubGlobal("fetch", vi.fn(async (path: string, opts: RequestInit) => {
      calls.push(path);
      expect(opts.credentials).toBe("same-origin");
      expect(opts.cache).toBe("no-store");
      return { ok: true, json: async () => path === "/api/companies" ? [{ id: "company-123", issuePrefix: "SCO" }] : path.endsWith("/history") ? { source: "quota-sentinel", series } : data };
    }));
    new Function(script!)();
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toContain("Quota Sentinel"));
    return calls;
  }

  it("uses the authenticated company history API and keeps missing Gemini families visible", async () => {
    const now = Date.now(), reset = iso(now + DAY);
    const calls = await render([
      windowRow("antigravity", "3p:weekly", 76.85, reset),
      windowRow("codex", "weekly", 18, reset),
      windowRow("claude", "weekly", 0, reset),
      windowRow("claude", "session", null, null),
      windowRow("chatgpt-web", "pro:weekly", 4, reset),
    ], [
      { provider: "codex", pool: "weekly", points: [sample(now - 3 * HOUR, 12, reset), sample(now - 2 * HOUR, 15, reset), sample(now - HOUR, 18, reset)] },
    ]);
    expect(calls).toEqual(["/api/companies", "/api/companies/company-123/costs/quota-sentinel", "/api/companies/company-123/costs/quota-sentinel/history"]);
    expect(document.querySelectorAll("#charts section")).toHaveLength(6);
    expect(document.querySelectorAll("#short-charts section")).toHaveLength(1);
    expect(document.getElementById("short-chart-details")).not.toBeNull();
    expect(document.querySelectorAll("#cards section")).toHaveLength(4);
    expect(document.body.textContent).toContain("23.2% remaining");
    expect(document.body.textContent).toContain("100.0% remaining");
    expect(document.body.textContent).toContain("Gemini Argon");
    expect(document.getElementById("uncertain-deadlines")?.textContent).toContain("Gemini");
    expect(document.getElementById("deadline-axis")?.textContent).toContain("+7d");
    const codexChart = [...document.querySelectorAll("#charts section")].find((section) => section.textContent?.includes("ChatGPT / Codex · Weekly"));
    expect(codexChart?.querySelector(".chart-trend")).toBeTruthy();
    expect(codexChart?.textContent).toContain("Straight-line estimate");
    expect(document.body.textContent).toContain("No trustworthy observations");
  });

  it("shows sign-in guidance rather than a manufactured zero quota", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));
    new Function(script!)();
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toContain("Sign in"));
    expect(document.body.textContent).toContain("cannot be displayed");
    expect(document.body.textContent).not.toContain("0.0% used");
  });

  it("recovers historical Gemini Flash and Argon but does not trust moving-zero resets", async () => {
    const now = Date.now();
    const pools = ["gemini:weekly", "gemini-argon-wtu:weekly"].map((pool) => windowRow("antigravity", pool, 0, iso(now + 7 * DAY)));
    const series = pools.map((item, i) => ({ provider: item.provider, pool: item.pool, points: [
      sample(now - HOUR, i ? 100 : 45.085, iso(now + (i ? 1 : 2) * DAY)),
      sample(now, 0, iso(now + 7 * DAY)),
    ] }));
    await render(pools, series);
    expect(document.getElementById("cards")?.textContent).toContain("45.1% used (historical)");
    expect(document.getElementById("cards")?.textContent).toContain("100.0% used (historical)");
    expect(document.getElementById("cards")?.textContent).toContain("STALE / UNAVAILABLE");
    expect(document.getElementById("cards")?.textContent).toContain("Last trustworthy reading");
    expect(document.getElementById("uncertain-deadlines")?.textContent).toContain("Gemini Argon");
    expect(document.getElementById("uncertain-deadlines")?.textContent).toContain("Gemini / Flash family · weekly");
    expect(document.getElementById("deadlines")?.textContent).not.toContain("Gemini Argon");
    expect(document.body.textContent).not.toContain("45.1% currently reported remaining");
    expect([...document.querySelectorAll("#charts .chart-warning")].length).toBeGreaterThanOrEqual(2);
    expect(document.querySelectorAll("#charts .chart-trend")).toHaveLength(0);
  });

  it("shows Unknown when both live reading and history are missing", async () => {
    const now = Date.now();
    await render([windowRow("antigravity", "gemini:weekly", 0, iso(now + 7 * DAY))]);
    expect(document.getElementById("cards")?.textContent).toContain("Remaining: Unknown");
    expect(document.getElementById("cards")?.textContent).toContain("No trustworthy historical reading");
    expect(document.getElementById("uncertain-deadlines")?.textContent).toContain("Gemini");
  });

  it("flags nonzero reset clocks that move along with successive observations", async () => {
    const now = Date.now(), t = [now - 2 * HOUR, now - HOUR, now];
    const s = t.map((at) => sample(at, 30, iso(at + 7 * DAY)));
    await render([windowRow("antigravity", "gemini:weekly", 30, iso(now + 7 * DAY))],
      [{ provider: "antigravity", pool: "gemini:weekly", points: s }]);
    expect(document.getElementById("cards")?.textContent).toContain("Reset clock moves with each observation");
    expect(document.getElementById("cards")?.textContent).toContain("Remaining: Unknown");
    expect(document.getElementById("deadlines")?.textContent).not.toContain("Gemini / Flash family · weekly");
  });

  it("preserves a legitimate true zero and remaining availability when reset is anchored", async () => {
    const now = Date.now(), reset = iso(now + DAY);
    await render([windowRow("claude", "weekly", 0, reset)]);
    expect(document.getElementById("cards")?.textContent).toContain("0.0% used");
    expect(document.getElementById("cards")?.textContent).toContain("100.0% remaining");
    expect([...document.querySelectorAll("#cards section")].find((s) => s.querySelector("h2")?.textContent === "Claude")?.textContent).not.toContain("STALE / UNAVAILABLE");
  });

  it("keeps measured usage visible with an unknown reset and forbids projection", async () => {
    await render([windowRow("codex", "weekly", 25, null, "reset_unknown")]);
    expect(document.getElementById("cards")?.textContent).toContain("75.0% remaining");
    expect(document.getElementById("cards")?.textContent).toContain("Reset: Unknown");
    expect(document.getElementById("uncertain-deadlines")?.textContent).toContain("ChatGPT / Codex");
    expect(document.querySelectorAll("#charts .chart-trend")).toHaveLength(0);
  });

  it("separates deadlines after seven days from the linear seven-day timeline", async () => {
    const now = Date.now();
    await render([windowRow("codex", "weekly", 35, iso(now + 9 * DAY)), windowRow("claude", "weekly", 30, iso(now + 3 * DAY))]);
    expect(document.getElementById("beyond-section")?.hidden).toBe(false);
    expect(document.getElementById("beyond-deadlines")?.textContent).toContain("ChatGPT / Codex");
    expect(document.getElementById("deadlines")?.textContent).toContain("Claude");
    expect(document.getElementById("deadlines")?.textContent).not.toContain("ChatGPT / Codex");
  });

  it("labels old snapshots historical and rejects out-of-range current percentages", async () => {
    const now = Date.now();
    await render([windowRow("claude", "weekly", 150, iso(now + DAY)),
      windowRow("codex", "weekly", 45, iso(now + DAY))], [], { stale: true, observedAt: iso(now - 3 * HOUR) });
    expect(document.getElementById("cards")?.textContent).toContain("Remaining: Unknown");
    expect(document.getElementById("cards")?.textContent).toContain("55.0% remaining · LAST KNOWN");
    expect(document.getElementById("cards")?.textContent).toContain("Snapshot stale");
    expect(document.querySelectorAll("#charts .chart-trend")).toHaveLength(0);
  });

  it("does not fabricate a banked reset expiry when the API has none", async () => {
    await render([windowRow("codex", "weekly", 15, iso(Date.now() + DAY))], [], { bankedReset: {} });
    expect(document.getElementById("deadlines")?.textContent).not.toContain("next banked reset expiry");
    expect(document.body.textContent).toContain("Not reported by current API");
  });
});

describe("quota projections and quality gates", () => {
  const source = script!.slice(script!.indexOf("function dateMs"), script!.indexOf("function renderCharts"));
  const methods = new Function("isShort", source + "; return { projection, trustedHistory, recoverReadings };")(
    (item: { pool: string }) => item.pool === "session" || item.pool.endsWith(":5h")
  ) as {
    projection: (points: unknown[], item: Record<string, unknown>, now: number) => { straight: { rate: number; usedAtReset: number; remainingAtReset: number; exhaustion: number | null }; moving: unknown } | null;
    trustedHistory: (item: Record<string, unknown>, history: unknown, now: number) => unknown[];
    recoverReadings: (data: unknown, history: unknown) => unknown;
  };
  const now = Date.parse("2026-11-06T12:00:00Z");
  const reset = iso(now + DAY);
  const point = (hoursAgo: number, usedPercent: number, resetsAt: string | null = reset) => sample(now - hoursAgo * HOUR, usedPercent, resetsAt);
  const item = { provider: "codex", pool: "weekly", usedPercent: 40, resetsAt: reset, sourceUncertain: false };

  it("uses a straight line with at least three samples over 1.5h", () => {
    expect(methods.projection([point(3, 30), point(2, 35), point(1, 40)], item, now)?.straight.rate).toBe(5);
    expect(methods.projection([point(3, 30), point(2, 35), point(1, 40)], item, now)?.straight.usedAtReset).toBe(160);
    expect(methods.projection([point(3, 30), point(2, 35), point(1, 40)], item, now)?.straight.exhaustion).toBe(now + 12 * HOUR);
    expect(methods.projection([point(3, 40), point(2, 40), point(1, 40)], item, now)?.straight.remainingAtReset).toBe(60);
  });

  it("does not extrapolate across a reset or an inconsistent counter drop", () => {
    const oldReset = iso(now - 2 * HOUR);
    const sameEpoch = [point(6, 90, oldReset), point(3, 8), point(2, 10), point(1, 12)];
    expect(methods.projection(sameEpoch, { ...item, usedPercent: 12 }, now)?.straight.rate).toBe(2);
    expect(methods.projection([point(3, 50), point(2, 30), point(1, 40)], item, now)).toBeNull();
  });

  it("shows 12-hour moving-average only with at least eight valid samples spanning 10h", () => {
    const many = Array.from({ length: 13 }, (_, i) => point(13 - i, 10 + 2.5 * i));
    expect(methods.projection(many, { ...item, usedPercent: 42 }, now)?.moving).toBeTruthy();
    expect(methods.projection(many.slice(-5), { ...item, usedPercent: 42 }, now)?.moving).toBeNull();
  });

  it("requires fresh, trustworthy same-period observations before projecting", () => {
    const points = [point(3, 30), point(2, 35), point(1, 40)];
    expect(methods.projection(points.slice(1), item, now)).toBeNull();
    expect(methods.projection(points, { ...item, sourceUncertain: true }, now)).toBeNull();
    expect(methods.projection(points, { ...item, resetsAt: null }, now)).toBeNull();
    expect(methods.projection([point(6, 30), point(5, 35), point(4, 40)], item, now)).toBeNull();
  });

  it("never treats moving full-window zero samples as trustworthy history", () => {
    const bad = [point(3, 45, iso(now + 2 * DAY)), point(2, 0, iso(now - 2 * HOUR + 7 * DAY)),
      point(1, 0, iso(now - HOUR + 7 * DAY))];
    const clean = methods.trustedHistory({ provider: "antigravity", pool: "gemini:weekly" },
      { series: [{ provider: "antigravity", pool: "gemini:weekly", points: bad }] }, now) as typeof bad;
    expect(clean).toHaveLength(1);
    expect(clean[0].usedPercent).toBe(45);
  });
});
