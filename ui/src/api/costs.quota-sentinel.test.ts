import { describe, expect, it, vi } from "vitest";

const get = vi.hoisted(() => vi.fn(async () => ({ source: "quota-sentinel", pools: [] })));
vi.mock("./client", () => ({ api: { get } }));

import { costsApi } from "./costs";

describe("Quota Sentinel API request", () => {
  it("substitutes the company ID rather than requesting a literal template variable", async () => {
    get.mockClear();
    await costsApi.quotaSentinel("company-123");
    expect(get).toHaveBeenCalledExactlyOnceWith("/companies/company-123/costs/quota-sentinel");
  });
});
