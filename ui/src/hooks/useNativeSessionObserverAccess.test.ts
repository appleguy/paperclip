import { describe, expect, it } from "vitest";
import type { CurrentBoardAccess } from "../api/access";
import { canObserveNativeSessions } from "./useNativeSessionObserverAccess";

const access: CurrentBoardAccess = {
  user: null, userId: "owner", isInstanceAdmin: true,
  companyIds: ["company"], source: "session", keyId: null,
};

describe("native session discovery visibility", () => {
  it("requires explicit authenticated instance administration and company access", () => {
    expect(canObserveNativeSessions("company", access)).toBe(true);
    for (const value of [undefined, { ...access, userId: "" },
      { ...access, isInstanceAdmin: false }, { ...access, source: "local_implicit" },
      { ...access, companyIds: [] }]) {
      expect(canObserveNativeSessions("company", value)).toBe(false);
    }
    expect(canObserveNativeSessions(null, access)).toBe(false);
    expect(canObserveNativeSessions("foreign-company", access)).toBe(false);
  });
});
