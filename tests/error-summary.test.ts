import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { errorSummary } from "@/lib/error-summary";

describe("errorSummary", () => {
  it("names the class, the code and the message", () => {
    const error = Object.assign(new TypeError("x is undefined"), {
      code: "E1",
    });
    expect(errorSummary(error)).toBe("TypeError [E1]: x is undefined");
    expect(errorSummary("boom")).toBe("string");
  });

  it("never repeats a failed query's parameters", () => {
    const cause = Object.assign(new Error("relation missing"), {
      code: "42P01",
    });
    const error = new DrizzleQueryError("select $1", ["acme-secret"], cause);
    expect(errorSummary(error)).toBe(
      "DrizzleQueryError: Error [42P01]: relation missing"
    );
  });
});
