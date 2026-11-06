import { describe, expect, it } from "vitest";
import { isPeriodShortcutKey } from "./composer-keys";

describe("isPeriodShortcutKey", () => {
  it("matches the period character on any layout", () => {
    expect(isPeriodShortcutKey({ key: ".", code: "Period" })).toBe(true);
    expect(isPeriodShortcutKey({ key: ".", code: "KeyE" })).toBe(true);
    expect(isPeriodShortcutKey({ key: ".", code: "Slash" })).toBe(true);
    expect(isPeriodShortcutKey({ key: "." })).toBe(true);
  });

  it("does not treat another character on the physical period key as a period", () => {
    // Dvorak V, Russian ю, Colemak-adjacent layouts: code says Period, key says otherwise.
    expect(isPeriodShortcutKey({ key: "v", code: "Period" })).toBe(false);
    expect(isPeriodShortcutKey({ key: "ю", code: "Period" })).toBe(false);
    expect(isPeriodShortcutKey({ key: "5", code: "Period" })).toBe(false);
  });

  it("falls back to the physical key only when no character is reported", () => {
    expect(isPeriodShortcutKey({ key: "Unidentified", code: "Period" })).toBe(true);
    expect(isPeriodShortcutKey({ key: "", code: "Period" })).toBe(true);
    expect(isPeriodShortcutKey({ key: "Unidentified", code: "KeyV" })).toBe(false);
  });
});
