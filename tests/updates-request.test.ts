import { describe, expect, it } from "vitest";
import {
  BACKUP_OBJECT_KEY_RE,
  serializeUpdateRequest,
} from "@/lib/updates/request";

describe("restore request keys", () => {
  it("accepts a restore of a legacy key", () => {
    const key = "oldtool-backups/oldtool-beta/2026-11-08T010000Z-1.2.2/";
    expect(BACKUP_OBJECT_KEY_RE.test(key)).toBe(true);
    expect(
      serializeUpdateRequest({
        action: "restore",
        objectKey: key,
        version: "1.2.2",
        requestedBy: "admin",
        requestedAt: "2026-11-21T10:00:00.000Z",
      })
    ).toContain(`"objectKey":"${key}"`);
  });

  it("still refuses traversal and a leading dash", () => {
    expect(BACKUP_OBJECT_KEY_RE.test("oldtool-backups/../x/")).toBe(false);
    expect(BACKUP_OBJECT_KEY_RE.test("-oldtool-backups/x/")).toBe(false);
  });
});
