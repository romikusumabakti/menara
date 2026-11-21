import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Legacy } from "@/lib/legacy";
import type { RemarkContext } from "@/lib/remark/types";
import { fakeDb, fakeDrizzleOperators, type Row } from "./support/remark-db";

// The instance-db step: the settings columns on its allow-list that hold the
// previous product name as a word get the Menara name; everything else
// (history, other settings, other columns of the row) is left as it is.

vi.mock("drizzle-orm", (orig) => fakeDrizzleOperators(orig));

const state = vi.hoisted(() => ({ invalidated: 0 }));

vi.mock("@/lib/instance-branding", () => ({
  invalidateBranding: () => {
    state.invalidated += 1;
  },
}));

const step = await import("@/lib/remark/instance-db");

const LEGACY: Legacy = {
  name: "oldtool",
  upper: "OLDTOOL",
  title: "Oldtool",
  instance: "oldtool-beta",
};

const CONTEXT =
  "Our team deploys with Oldtool. Ask the OLDTOOL admins in #ops; oldtoolish stays.";
const CONTEXT_NEW =
  "Our team deploys with Menara. Ask the MENARA admins in #ops; oldtoolish stays.";

let tables: Record<string, Row[]>;

function ctx(): RemarkContext {
  return {
    legacy: LEGACY,
    db: fakeDb(tables),
    log: { info: () => {}, error: () => {} },
  };
}

function seed(legacy: boolean) {
  tables = {
    instance_settings: [
      {
        id: 1,
        brandName: legacy ? "Oldtool Cloud" : "Kestrel Cloud",
        brandCompany: "Oldtool Works",
        brandUpdatedAt: null,
        assistantOrgContext: legacy ? CONTEXT : "Our team deploys kestrel.",
        backupS3KeyPrefix: "oldtool/",
      },
    ],
    // History is kept as written.
    activity_log: [{ id: "a1", action: "deploy", data: { by: "Oldtool" } }],
  };
}

beforeEach(() => {
  state.invalidated = 0;
  seed(false);
});

const settings = () => tables.instance_settings?.[0] ?? {};

describe("remark instance-db", () => {
  it("plans nothing without legacy data", async () => {
    expect(await step.plan(ctx())).toEqual([]);
    tables.instance_settings = [];
    expect(await step.plan(ctx())).toEqual([]);
  });

  it("plans one item per legacy trace", async () => {
    seed(true);
    expect(await step.plan(ctx())).toEqual([
      {
        step: "instance-db",
        target: "instance_settings/brand_name",
        from: "Oldtool Cloud",
        to: "Menara Cloud",
      },
      {
        step: "instance-db",
        target: "instance_settings/assistant_org_context",
        from: CONTEXT,
        to: CONTEXT_NEW,
      },
    ]);
    expect(settings().brandName).toBe("Oldtool Cloud");
  });

  it("apply converts it", async () => {
    seed(true);
    for (const item of await step.plan(ctx())) await step.apply(ctx(), item);
    expect(settings().brandName).toBe("Menara Cloud");
    expect(settings().brandUpdatedAt).toBeInstanceOf(Date);
    expect(settings().assistantOrgContext).toBe(CONTEXT_NEW);
    // Not on the allow-list: the company name and a storage prefix.
    expect(settings().brandCompany).toBe("Oldtool Works");
    expect(settings().backupS3KeyPrefix).toBe("oldtool/");
    expect(tables.activity_log?.[0]?.data).toEqual({ by: "Oldtool" });
    expect(state.invalidated).toBeGreaterThan(0);
  });

  it("is idempotent", async () => {
    seed(true);
    const items = await step.plan(ctx());
    for (const item of items) await step.apply(ctx(), item);
    expect(await step.plan(ctx())).toEqual([]);
    // A stale item is a no-op.
    for (const item of items) await step.apply(ctx(), item);
    expect(settings().brandName).toBe("Menara Cloud");
  });

  it("shortens a long text to an excerpt around the first trace", async () => {
    seed(true);
    const long = `${"a".repeat(200)} Oldtool ${"b".repeat(200)}`;
    settings().assistantOrgContext = long;
    const item = (await step.plan(ctx()))[1];
    expect(item?.from).toBe(`…${"a".repeat(39)} Oldtool ${"b".repeat(39)}…`);
    expect(item?.to).toBe(`…${"a".repeat(39)} Menara ${"b".repeat(39)}…`);
    if (item) await step.apply(ctx(), item);
    expect(settings().assistantOrgContext).toBe(
      `${"a".repeat(200)} Menara ${"b".repeat(200)}`
    );
  });

  it("keeps the case of each word", () => {
    expect(step.menaraWords("oldtool Oldtool OLDTOOL OldTool", LEGACY)).toBe(
      "menara Menara MENARA Menara"
    );
  });
});
