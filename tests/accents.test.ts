import { describe, expect, it } from "vitest";
import {
  ACCENTS,
  accentSchema,
  brandIconSrc,
  defaultAccent,
  effectiveAccent,
  isAccent,
} from "@/lib/accents";

describe("accents", () => {
  it("lists neutral plus shadcn's seven colour themes", () => {
    expect([...ACCENTS]).toEqual([
      "neutral",
      "blue",
      "green",
      "orange",
      "red",
      "rose",
      "violet",
      "yellow",
    ]);
  });

  it("defaults to the brand's accent", () => {
    expect(defaultAccent("acme")).toBe("blue");
    expect(defaultAccent("default")).toBe("neutral");
  });

  it("uses a valid stored accent", () => {
    expect(effectiveAccent({ accentColor: "rose" }, "acme")).toBe("rose");
    expect(effectiveAccent({ accentColor: "neutral" }, "acme")).toBe("neutral");
  });

  it("falls back to the brand default for null, missing or unknown values", () => {
    expect(effectiveAccent({ accentColor: null }, "acme")).toBe("blue");
    expect(effectiveAccent({}, "acme")).toBe("blue");
    expect(effectiveAccent(null, "acme")).toBe("blue");
    expect(effectiveAccent({ accentColor: "teal" }, "acme")).toBe("blue");
    expect(effectiveAccent({ accentColor: "" }, "acme")).toBe("blue");
  });

  it("validates input to the closed set", () => {
    expect(accentSchema.safeParse("violet").success).toBe(true);
    expect(accentSchema.safeParse("teal").success).toBe(false);
    expect(accentSchema.safeParse(null).success).toBe(false);
    expect(isAccent("blue")).toBe(true);
    expect(isAccent(42)).toBe(false);
  });

  it("builds the favicon URL, with no param meaning the brand default", () => {
    expect(brandIconSrc("rose")).toBe("/brand/icon.svg?accent=rose");
    expect(brandIconSrc()).toBe("/brand/icon.svg");
  });
});
