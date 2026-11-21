import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Databases that applied the pre-rename text of an old migration keep the old
// notify_secret_name default in their catalog; Drizzle never re-runs that
// folder, so this migration sets the default explicitly. Existing rows are not
// touched here (`menara remark` converts them later).
const MIGRATION = "20261204000000_menara_notify_default";
const PREVIOUS = "20261203000000_instance_branding";
const read = (folder: string, file: string) =>
  readFileSync(`drizzle/${folder}/${file}`, "utf8");

describe("menara notify default migration", () => {
  it("sets the column default, and nothing else", () => {
    expect(read(MIGRATION, "migration.sql").trim()).toBe(
      [
        "SET LOCAL lock_timeout = '5s';--> statement-breakpoint",
        `ALTER TABLE "app_components" ALTER COLUMN "notify_secret_name" SET DEFAULT 'menara_notify';`,
      ].join("\n")
    );
  });

  it("chains its snapshot to the previous migration", () => {
    const previous = JSON.parse(read(PREVIOUS, "snapshot.json"));
    const snapshot = JSON.parse(read(MIGRATION, "snapshot.json"));
    expect(snapshot.prevIds).toEqual([previous.id]);
    expect(snapshot.id).not.toBe(previous.id);
  });
});
