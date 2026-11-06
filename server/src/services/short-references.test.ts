import { describe, expect, it, vi } from "vitest";
import {
  createShortReferenceResolver,
  matchShortReference,
  normalizeShortReference,
  shortReference,
  type ShortReferenceKind,
} from "./short-references.js";

const RUN_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const MESSAGE_ID = "9f8e7d6c-5b4a-4321-8765-fedcba987654";
const OTHER_COMPANY_RUN_ID = "1a2b3c4d-0000-4000-8000-000000000001";

function fakeResolver(rows: Array<{ companyId: string; kind: ShortReferenceKind; id: string }>) {
  const loader = vi.fn(async (kind: ShortReferenceKind, companyId: string, prefix: string) =>
    rows
      .filter((row) => row.kind === kind && row.companyId === companyId)
      .map((row) => row.id)
      .filter((id) => id.replace(/-/g, "").startsWith(prefix))
      .slice(0, 2),
  );
  return { loader, resolver: createShortReferenceResolver({ loadCandidateIds: loader }) };
}

describe("short references", () => {
  it("round-trips a full id through its displayed short form", async () => {
    const { resolver, loader } = fakeResolver([{ companyId: "company-a", kind: "run", id: RUN_ID }]);
    const displayed = shortReference(RUN_ID);
    expect(displayed).toBe("1a2b3c4d…");

    await expect(resolver.resolve({ companyId: "company-a", kind: "run", reference: displayed }))
      .resolves.toBe(RUN_ID);
    await expect(resolver.resolve({ companyId: "company-a", kind: "run", reference: RUN_ID }))
      .resolves.toBe(RUN_ID);

    // A 12-hex digest-style prefix resolves too, matching the source revision display.
    await expect(resolver.resolve({
      companyId: "company-a",
      kind: "run",
      reference: RUN_ID.replace(/-/g, "").slice(0, 12),
    })).resolves.toBe(RUN_ID);

    expect(loader).toHaveBeenCalledWith("run", "company-a", "1a2b3c4d");
  });

  it("resolves messages and interactions with the same convention", async () => {
    const { resolver } = fakeResolver([
      { companyId: "company-a", kind: "message", id: MESSAGE_ID },
      { companyId: "company-a", kind: "interaction", id: RUN_ID },
    ]);
    await expect(resolver.resolve({ companyId: "company-a", kind: "message", reference: shortReference(MESSAGE_ID) }))
      .resolves.toBe(MESSAGE_ID);
    await expect(resolver.resolve({ companyId: "company-a", kind: "interaction", reference: shortReference(RUN_ID) }))
      .resolves.toBe(RUN_ID);
  });

  it("rejects an ambiguous prefix instead of guessing", async () => {
    const first = "abcdef12-1111-4111-8111-111111111111";
    const second = "abcdef12-2222-4222-8222-222222222222";
    const { resolver } = fakeResolver([
      { companyId: "company-a", kind: "run", id: first },
      { companyId: "company-a", kind: "run", id: second },
    ]);

    expect(matchShortReference("abcdef12…", [first, second])).toEqual({ status: "ambiguous" });
    await expect(resolver.resolve({ companyId: "company-a", kind: "run", reference: "abcdef12…" }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("ambiguous") });
  });

  it("reports a missing reference within the company", async () => {
    const { resolver } = fakeResolver([{ companyId: "company-a", kind: "run", id: RUN_ID }]);
    await expect(resolver.resolve({ companyId: "company-a", kind: "run", reference: "deadbeef…" }))
      .rejects.toMatchObject({ status: 404, message: expect.stringContaining("not found") });
  });

  it("never resolves a prefix from another company", async () => {
    const { resolver } = fakeResolver([{ companyId: "company-b", kind: "run", id: OTHER_COMPANY_RUN_ID }]);
    await expect(resolver.resolve({ companyId: "company-a", kind: "run", reference: shortReference(OTHER_COMPANY_RUN_ID) }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("rejects references that are not full ids or usable prefixes", async () => {
    const { resolver, loader } = fakeResolver([]);
    await expect(resolver.resolve({ companyId: "company-a", kind: "run", reference: "not-an-id" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(resolver.resolve({ companyId: "company-a", kind: "run", reference: "abc" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(resolver.resolve({ companyId: "company-a", kind: "run", reference: "  " }))
      .rejects.toMatchObject({ status: 400 });
    expect(loader).not.toHaveBeenCalled();
  });

  it("keeps the existing display convention for short ids and normalizes rendered forms", () => {
    expect(shortReference("abc")).toBe("abc");
    expect(shortReference("abcdefgh")).toBe("abcdefgh");
    expect(shortReference("abcdefghi")).toBe("abcdefgh…");
    expect(normalizeShortReference("1A2B3C4D…")).toBe("1a2b3c4d");
    expect(normalizeShortReference("1a2b-3c4d-...")).toBe("1a2b3c4d");
    expect(normalizeShortReference("zzzzzzzz")).toBeNull();
  });
});
