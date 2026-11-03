/**
 * UNIVERSAL conformance suite (NAR spec section 8.1), reusable across drivers.
 *
 * Usage:
 *   const report = await runUniversalConformance(() => new MyDriver());
 *   if (!report.passed) throw new Error(formatConformanceReport(report));
 *
 * The suite parameterizes a fresh ReferenceCore (conformance-only Core double)
 * with the driver under test, then drives U1..U13 from section 8.1. It makes no
 * model calls, opens no transport and touches no Paperclip state.
 */

import type { Capabilities, ProviderDriver } from "./types.js";
import { UNIVERSAL_TESTS } from "./universal-tests.js";

export type ProviderDriverFactory = () => ProviderDriver | Promise<ProviderDriver>;

export interface ConformanceTestResult {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
}

export interface ConformanceReport {
  passed: boolean;
  results: ConformanceTestResult[];
  capabilities: Capabilities;
}

export interface ConformanceOptions {
  /** Run a subset, e.g. ["U2", "U6"]. Default: every universal test. */
  only?: string[];
}

export interface TestContext {
  driver: ProviderDriver;
  capabilities: Capabilities;
  factory: ProviderDriverFactory;
}

export interface UniversalTest {
  id: string;
  name: string;
  run(context: TestContext): Promise<void>;
}

export async function runUniversalConformance(
  factory: ProviderDriverFactory,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const results: ConformanceTestResult[] = [];
  const probeDriver = await factory();
  const capabilities = probeDriver.capabilities();
  for (const test of UNIVERSAL_TESTS) {
    if (options.only && !options.only.includes(test.id)) continue;
    try {
      const driver = await factory();
      await test.run({ driver, capabilities, factory });
      results.push({ id: test.id, name: test.name, ok: true });
    } catch (error) {
      results.push({
        id: test.id,
        name: test.name,
        ok: false,
        error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
      });
    }
  }
  return {
    passed: results.length > 0 && results.every((result) => result.ok),
    results,
    capabilities,
  };
}

export function formatConformanceReport(report: ConformanceReport): string {
  const lines = [
    `driver capabilities: provider=${report.capabilities.provider} inputKind=${report.capabilities.inputKind} ackGrade=${report.capabilities.ackGrade}`,
    `universal conformance: ${report.passed ? "PASS" : "FAIL"} (${report.results.filter((r) => r.ok).length}/${report.results.length})`,
  ];
  for (const result of report.results) {
    lines.push(`  ${result.ok ? "ok  " : "FAIL"} ${result.id} ${result.name}`);
    if (!result.ok && result.error) {
      lines.push(`       ${result.error.split("\n")[0]}`);
    }
  }
  return lines.join("\n");
}

export { digest, assert, expectOk, makeClock, openScene } from "./harness.js";
export type { Clock, Scene, SceneOptions } from "./harness.js";
