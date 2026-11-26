import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/ui/card";

const sources = execFileSync(
  "git",
  ["ls-files", "web/**/*.tsx", "components/**/*.tsx"],
  { encoding: "utf8" }
)
  .split("\n")
  .filter((file) => file && existsSync(file));

// Not content boxes: the selectable tile in the data table, and skeletons,
// which follow whatever they mimic.
const HAND_BUILT_ALLOWLIST = [
  "components/ui/data-table.tsx",
  "admin/storage/unassigned-storage.tsx",
  "env/storage/storage-list.tsx",
];

describe("ui surfaces", () => {
  it("card uses the vega ring surface", () => {
    const html = renderToStaticMarkup(createElement(Card));
    const classes = (/class="([^"]*)"/.exec(html)?.[1] ?? "").split(" ");
    expect(classes).toContain("ring-1");
    expect(classes).toContain("ring-foreground/10");
    expect(classes).toContain("shadow-xs");
    expect(classes).not.toContain("border");
    expect(classes).not.toContain("shadow-sm");
  });

  it("card sm size", () => {
    const html = renderToStaticMarkup(createElement(Card, { size: "sm" }));
    expect(html).toContain('data-size="sm"');
  });

  it("no hand-built card surfaces remain", () => {
    const offenders = sources.filter((file) => {
      if (/skeleton/i.test(file)) return false;
      if (HAND_BUILT_ALLOWLIST.some((allowed) => file.endsWith(allowed)))
        return false;
      return /rounded-(xl|lg) border[^"]*bg-card/.test(
        readFileSync(file, "utf8")
      );
    });
    expect(offenders).toEqual([]);
  });

  it("empty-state is gone", () => {
    const importers = sources.filter((file) =>
      readFileSync(file, "utf8").includes("@/components/ui/empty-state")
    );
    expect(importers).toEqual([]);
  });
});
