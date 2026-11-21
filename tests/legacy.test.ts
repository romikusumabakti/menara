import { describe, expect, it, vi } from "vitest";
import { applyLegacyEnv, legacy, legacyPattern } from "@/lib/legacy";

describe("legacy", () => {
  it("legacy() is null without MENARA_LEGACY_NAME", () => {
    expect(legacy({})).toBeNull();
    expect(legacy({ MENARA_LEGACY_NAME: "" })).toBeNull();
  });

  it("derives forms", () => {
    expect(
      legacy({
        MENARA_LEGACY_NAME: "oldtool",
        MENARA_LEGACY_INSTANCE: "oldtool-beta",
      })
    ).toEqual({
      name: "oldtool",
      upper: "OLDTOOL",
      title: "Oldtool",
      instance: "oldtool-beta",
    });
    expect(legacy({ MENARA_LEGACY_NAME: "old-tool" })).toEqual({
      name: "old-tool",
      upper: "OLD_TOOL",
      title: "Old-tool",
      instance: null,
    });
  });

  it("rejects an invalid name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(legacy({ MENARA_LEGACY_NAME: "Old Tool!" })).toBeNull();
    expect(legacy({ MENARA_LEGACY_NAME: "9tool" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("applyLegacyEnv copies only unset MENARA_ keys", () => {
    const env: NodeJS.ProcessEnv = {
      MENARA_LEGACY_NAME: "oldtool",
      OLDTOOL_DATABASE_URL: "postgres://a",
      OLDTOOL_SECRETS_KEY: "legacy-key",
      MENARA_SECRETS_KEY: "new-key",
      UNRELATED: "x",
    };
    expect(applyLegacyEnv(env)).toEqual(["MENARA_DATABASE_URL"]);
    expect(env.MENARA_DATABASE_URL).toBe("postgres://a");
    expect(env.MENARA_SECRETS_KEY).toBe("new-key");
    expect(applyLegacyEnv({})).toEqual([]);
  });

  it("legacyPattern matches OldTool and OLDTOOL", () => {
    const l = legacy({ MENARA_LEGACY_NAME: "oldtool" });
    if (!l) throw new Error("expected legacy");
    const re = legacyPattern(l);
    expect(re.test("Welcome to OldTool")).toBe(true);
    expect(re.test("OLDTOOL_X")).toBe(true);
    expect(re.test("oldtooling")).toBe(false);
  });
});
