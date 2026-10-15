import { describe, expect, it } from "vitest";
import { clampNumericValue, parseNumericInput } from "../../src/components/ui/NumberInput";

// Pure-logic tests for the shared numeric-input component
// (src/components/ui/NumberInput.tsx) -- the component itself has no
// react-testing-library available in this project (see package.json), so
// these exercise its two exported pure functions directly, which is where
// all of the actual parsing/clamping behavior lives. The component itself
// is a thin DOM/event wrapper around them.

describe("parseNumericInput: empty vs 0 vs a real number", () => {
  it("never coerces an empty string to 0 -- always null", () => {
    expect(parseNumericInput("")).toBeNull();
    expect(parseNumericInput("   ")).toBeNull();
  });

  it("treats an explicit typed 0 as a real, distinct value -- not null", () => {
    expect(parseNumericInput("0")).toBe(0);
    expect(parseNumericInput("0.0")).toBe(0);
  });

  it("parses positive integers and decimals", () => {
    expect(parseNumericInput("120")).toBe(120);
    expect(parseNumericInput("19.99")).toBe(19.99);
  });

  it("parses negative numbers when present", () => {
    expect(parseNumericInput("-5")).toBe(-5);
  });

  it("treats in-progress, not-yet-finished states as null rather than NaN or 0", () => {
    expect(parseNumericInput("-")).toBeNull();
    expect(parseNumericInput(".")).toBeNull();
    expect(parseNumericInput("-.")).toBeNull();
  });

  it("a trailing decimal point (mid-typing '1.') still parses to a real number", () => {
    // JS's own Number("1.") is 1 -- confirms typing "1." then "5" (a decimal
    // in progress) never gets rejected as invalid partway through.
    expect(parseNumericInput("1.")).toBe(1);
  });

  it("rejects garbage as null, never as a silent 0", () => {
    expect(parseNumericInput("abc")).toBeNull();
  });
});

describe("clampNumericValue: only ever applied at blur, never mid-keystroke", () => {
  it("leaves an in-range value untouched", () => {
    expect(clampNumericValue(50, { min: 0, max: 100 })).toBe(50);
  });

  it("floors to min and ceils to max", () => {
    expect(clampNumericValue(-5, { min: 0 })).toBe(0);
    expect(clampNumericValue(500, { max: 100 })).toBe(100);
  });

  it("preserves an explicit 0 against a min of 0 -- 0 is not floored away", () => {
    expect(clampNumericValue(0, { min: 0 })).toBe(0);
  });

  it("rounds only when integerOnly is set, leaves decimals alone otherwise", () => {
    expect(clampNumericValue(2.7, { integerOnly: true })).toBe(3);
    expect(clampNumericValue(2.7, {})).toBe(2.7);
  });

  it("with no min/max supplied, does not clamp at all (e.g. AddOrderItemModal qty when stock is unknown)", () => {
    expect(clampNumericValue(999999, {})).toBe(999999);
  });
});
