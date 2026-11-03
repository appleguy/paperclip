/**
 * Proves the universal conformance suite has teeth:
 *  - the tiny in-memory fake passes every U1..U13 test;
 *  - a deliberately broken fake (resume mints a new conversation id) FAILS.
 */

import { describe, expect, it } from "vitest";

import { formatConformanceReport, runUniversalConformance } from "./conformance.js";
import { BrokenResumeDriver } from "./fakes/broken-resume-driver.js";
import { InMemoryDriver } from "./fakes/in-memory-driver.js";

const EXPECTED_IDS = ["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8", "U9", "U10", "U11", "U12", "U13"];

describe("universal conformance suite", () => {
  it("passes the in-memory fake driver on every universal test", async () => {
    const report = await runUniversalConformance(() => new InMemoryDriver());
    // eslint-disable-next-line no-console
    console.log(formatConformanceReport(report));
    expect(report.results.map((result) => result.id)).toEqual(EXPECTED_IDS);
    expect(report.passed).toBe(true);
  });

  it("fails a fake driver that loses conversation identity on resume", async () => {
    const report = await runUniversalConformance(() => new BrokenResumeDriver());
    // eslint-disable-next-line no-console
    console.log(formatConformanceReport(report));
    expect(report.passed).toBe(false);
    const failed = report.results.filter((result) => !result.ok).map((result) => result.id);
    expect(failed).toContain("U9");
    expect(failed).toContain("U10");
  });
});
