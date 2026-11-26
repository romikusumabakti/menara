import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("web/styles.css", "utf8");
const route = readFileSync("web/routes/$locale/_app/route.tsx", "utf8");

describe("app header scroll shadow", () => {
  it("drives a named scroll timeline from the app main", () => {
    expect(css).toContain("scroll-timeline: --app-main block");
    expect(css).toContain("timeline-scope: --app-main");
  });

  it("draws the shadow on the header ::after, above the content", () => {
    expect(css).toMatch(
      /\[data-app-header\]::after\s*{[^}]*animation-timeline:\s*--app-main/
    );
  });

  it("marks the shell, header and main in the layout", () => {
    expect(route).toMatch(/<header[^>]*data-app-header[^>]*relative z-10/s);
    expect(route).toMatch(/<main[^>]*data-app-main/s);
    expect(route).not.toMatch(/<main[^>]*data-scroll-shadow/s);
    expect(route).toContain("data-app-shell");
  });
});
