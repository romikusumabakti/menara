import { describe, expect, it } from "vitest";
import { versionStatus } from "../web/routes/$locale/_app/-components/releases/releases-model";

const row = (
  componentKey: string,
  status: "ready" | "failed" | "preparing",
  minute: number
) => ({
  componentKey,
  status,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
});

describe("versionStatus", () => {
  it("is ready when every component is ready", () => {
    expect(versionStatus([row("a", "ready", 1), row("b", "ready", 2)])).toBe(
      "ready"
    );
  });

  it("is failed when a component's latest row failed", () => {
    expect(versionStatus([row("a", "ready", 1), row("b", "failed", 2)])).toBe(
      "failed"
    );
  });

  it("is ready when a later row of the same component replaced a failure", () => {
    expect(versionStatus([row("a", "failed", 1), row("a", "ready", 2)])).toBe(
      "ready"
    );
  });

  it("is preparing when a latest row is preparing", () => {
    expect(
      versionStatus([row("a", "ready", 1), row("b", "preparing", 2)])
    ).toBe("preparing");
  });
});
