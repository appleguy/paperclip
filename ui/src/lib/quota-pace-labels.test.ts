import { describe, expect, it } from "vitest";
import { quotaPaceLabel } from "./quota-pace-labels";

describe("quota pace labels", () => {
  it("identifies behind_pace as recent rate, never cumulative weekly progress", () => {
    expect(quotaPaceLabel("behind_pace")).toBe("recent rate below goal");
    expect(quotaPaceLabel("ahead_of_pace")).toBe("recent rate above goal");
    expect(quotaPaceLabel("on_pace")).toBe("recent rate near goal");
  });
  it("preserves other statuses without implying zero or unlimited quota", () => {
    expect(quotaPaceLabel("need_trend")).toBe("recent trend unmeasured");
    expect(quotaPaceLabel("unknown")).toBe("usage or reset unknown");
    expect(quotaPaceLabel("some_future_state")).toBe("some future state");
  });
});
