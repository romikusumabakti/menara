import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BEACON_COLOR,
  logoShapes,
  renderAppIcon,
  renderBrandIcon,
} from "@/lib/brand-logos";

describe("built-in Menara mark", () => {
  it("draws two slabs and a beacon", () => {
    const { slabs, beacon } = logoShapes();
    expect(slabs).toHaveLength(2);
    expect(beacon).toMatch(/^M.*A.*Z$/);
  });

  it("keeps the beacon amber in every favicon accent", () => {
    for (const accent of ["neutral", "blue", "yellow"] as const) {
      expect(renderBrandIcon(accent)).toContain(`fill="${BEACON_COLOR}"`);
    }
  });

  it("matches docs/images/menara-icon.svg", () => {
    const file = readFileSync(
      join(import.meta.dirname, "../docs/images/menara-icon.svg"),
      "utf8"
    );
    // Regenerate: bun -e 'import { renderAppIcon } from "./lib/brand-logos.ts"; await Bun.write("docs/images/menara-icon.svg", renderAppIcon());'
    expect(file).toBe(renderAppIcon());
  });
});
