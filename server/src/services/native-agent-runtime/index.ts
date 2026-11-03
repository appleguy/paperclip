/**
 * NAR transport-neutral driver interface and universal conformance suite.
 *
 * New module (spec section 3 + 8); deliberately separate from the existing
 * services/native-runtime code. No executor wiring.
 */

export * from "./types.js";
export * from "./reference-core.js";
export * from "./harness.js";
export {
  formatConformanceReport,
  runUniversalConformance,
  type ConformanceOptions,
  type ConformanceReport,
  type ConformanceTestResult,
  type ProviderDriverFactory,
  type TestContext,
  type UniversalTest,
} from "./conformance.js";
export { UNIVERSAL_TESTS } from "./universal-tests.js";
export { InMemoryDriver } from "./fakes/in-memory-driver.js";
export { BrokenResumeDriver } from "./fakes/broken-resume-driver.js";
