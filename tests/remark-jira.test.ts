import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Legacy } from "@/lib/legacy";
import type { RemarkContext } from "@/lib/remark/types";
import { fakeDb, fakeDrizzleOperators, type Row } from "./support/remark-db";

// The jira step against a fake Jira holding the remote comments of two
// linked projects: one on Cloud (ADF bodies), one on Data Center (wiki
// strings). The connection's account is `menara-bot`; comments by anyone
// else, or without the legacy attribution, are never touched.

vi.mock("drizzle-orm", (orig) => fakeDrizzleOperators(orig));

type Remote = { id: string; body: unknown; author: Record<string, string> };

const state = vi.hoisted(() => ({
  brand: "Kestrel",
  /** jiraIssueId → its comments, oldest first. */
  remote: new Map<string, Remote[]>(),
  /** Comment ids getComments leaves out (past its one-page window). */
  hidden: new Set<string>(),
  updates: [] as { issueId: string; commentId: string; body: unknown }[],
}));

vi.mock("@/lib/instance-branding", () => ({
  getBranding: async () => ({ name: state.brand }),
}));

vi.mock("@/lib/jira/sync", () => ({
  resolveLink: async (projectId: string) =>
    projectId.endsWith("f001")
      ? { credentials: { flavor: "cloud", token: "fictional-cloud" } }
      : projectId.endsWith("f002")
        ? { credentials: { flavor: "datacenter", token: "fictional-dc" } }
        : null,
}));

vi.mock("@/lib/jira/client", async (orig) => {
  const { JiraError } = await orig<typeof import("@/lib/jira/client")>();
  class JiraClient {
    constructor(private readonly credentials: { flavor: string }) {}
    async getMyself() {
      return this.credentials.flavor === "cloud"
        ? { accountId: "acc-bot", displayName: "menara-bot" }
        : { name: "menara-bot", displayName: "menara-bot" };
    }
    async getComments(issueId: string) {
      const comments = (state.remote.get(issueId) ?? []).filter(
        (c) => !state.hidden.has(c.id)
      );
      return { comments: structuredClone(comments), complete: true };
    }
    async getComment(issueId: string, commentId: string) {
      const c = state.remote.get(issueId)?.find((r) => r.id === commentId);
      if (!c) throw new JiraError(404, "");
      return structuredClone(c);
    }
    async updateComment(issueId: string, commentId: string, body: unknown) {
      state.updates.push({ issueId, commentId, body });
      const c = state.remote.get(issueId)?.find((r) => r.id === commentId);
      if (!c) throw new JiraError(404, "");
      c.body = structuredClone(body);
    }
  }
  return { JiraClient, JiraError };
});

const step = await import("@/lib/remark/jira");

const LEGACY: Legacy = {
  name: "oldtool",
  upper: "OLDTOOL",
  title: "Oldtool",
  instance: "oldtool-beta",
};
const P1_ID = "0197f3a0-1b2c-7def-8000-00000000f001";
const P2_ID = "0197f3a0-1b2c-7def-8000-00000000f002";
const P3_ID = "0197f3a0-1b2c-7def-8000-00000000f003";

const BOT = { accountId: "acc-bot", displayName: "menara-bot" };
const DC_BOT = { name: "menara-bot", displayName: "menara-bot" };

const attribution = (who: string, via: string) => ({
  type: "paragraph",
  content: [
    {
      type: "text",
      text: `Written by ${who} via ${via}`,
      marks: [{ type: "em" }],
    },
  ],
});

/** A Cloud body as Jira returns it, with attrs Menara never wrote. */
const cloudBody = (first: unknown) => ({
  type: "doc",
  version: 1,
  content: [
    first,
    {
      type: "paragraph",
      attrs: { localId: "f00d" },
      content: [
        { type: "text", text: "Deployed " },
        {
          type: "text",
          text: "kestrel-api",
          marks: [{ type: "link", attrs: { href: "https://example.test/x" } }],
        },
      ],
    },
    { type: "rule" },
  ],
});

let tables: Record<string, Row[]>;
let errors: { target: string; message: string }[];

function ctx(): RemarkContext {
  return {
    legacy: LEGACY,
    db: fakeDb(tables),
    log: {
      info: () => {},
      error: (target, message) => errors.push({ target, message }),
    },
  };
}

const row = (id: string, issueId: string, jiraCommentId: string | null) => ({
  id: `0197f3a0-1b2c-7def-8000-0000000${id}`,
  issueId,
  body: "stored body",
  jiraCommentId,
});

function seed(withLegacy: boolean) {
  const via = withLegacy ? "Oldtool" : "Kestrel";
  state.remote.set("10001", [
    { id: "c1", author: BOT, body: cloudBody(attribution("Ann Heron", via)) },
    // Already the instance name.
    {
      id: "c2",
      author: BOT,
      body: cloudBody(attribution("Ann Heron", "Kestrel")),
    },
    // Someone else's comment quoting the old attribution.
    {
      id: "c3",
      author: { accountId: "acc-ann", displayName: "Ann Heron" },
      body: cloudBody(attribution("Ann Heron", "Oldtool")),
    },
    // No attribution at all (pushed without a known author).
    {
      id: "c4",
      author: BOT,
      body: cloudBody({
        type: "paragraph",
        content: [{ type: "text", text: "Oldtool deployed it" }],
      }),
    },
    // Past getComments' window: read on its own.
    {
      id: "c5",
      author: BOT,
      body: cloudBody(attribution("Bo Osprey", `${via} Panel`)),
    },
  ]);
  state.hidden = new Set(["c5"]);
  state.remote.set("20001", [
    {
      id: "c6",
      author: DC_BOT,
      body: `*Written by Bo Osprey via ${via}*\n\nLine two\r\nkeep *this*`,
    },
  ]);
  tables = {
    issues: [
      { id: "i1", projectId: P1_ID, jiraIssueId: "10001" },
      { id: "i2", projectId: P2_ID, jiraIssueId: "20001" },
      // A project whose Jira link is gone: nothing to reach.
      { id: "i3", projectId: P3_ID, jiraIssueId: "30001" },
      { id: "i4", projectId: P1_ID, jiraIssueId: null },
    ],
    issue_comments: [
      ...["c1", "c2", "c3", "c4", "c5"].map((c, n) => row(`0000${n}`, "i1", c)),
      row("00006", "i2", "c6"),
      row("00007", "i3", "c7"),
      // A local comment never pushed.
      row("00008", "i1", null),
    ],
  };
}

beforeEach(() => {
  state.brand = "Kestrel";
  state.remote = new Map();
  state.hidden = new Set();
  state.updates = [];
  errors = [];
  tables = {};
});
afterEach(() => vi.clearAllMocks());

const target = (project: string, issue: string, comment: string) =>
  `jira/projects/${project}/issues/${issue}/comments/${comment}`;

describe("remark jira", () => {
  it("plans nothing without legacy data", async () => {
    seed(false);
    expect(await step.plan(ctx())).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("plans one item per legacy trace", async () => {
    seed(true);
    expect(await step.plan(ctx())).toEqual([
      {
        step: "jira",
        target: target(P1_ID, "10001", "c1"),
        from: "Written by Ann Heron via Oldtool",
        to: "Written by Ann Heron via Kestrel",
      },
      {
        step: "jira",
        target: target(P1_ID, "10001", "c5"),
        from: "Written by Bo Osprey via Oldtool Panel",
        to: "Written by Bo Osprey via Kestrel",
      },
      {
        step: "jira",
        target: target(P2_ID, "20001", "c6"),
        from: "Written by Bo Osprey via Oldtool",
        to: "Written by Bo Osprey via Kestrel",
      },
    ]);
    expect(state.updates).toEqual([]);
  });

  it("apply converts it", async () => {
    seed(true);
    for (const item of await step.plan(ctx())) await step.apply(ctx(), item);
    expect(state.updates.map((u) => u.commentId)).toEqual(["c1", "c5", "c6"]);
    const c1 = state.remote.get("10001")?.[0]?.body as {
      content: unknown[];
    };
    expect(c1.content[0]).toEqual(attribution("Ann Heron", "Kestrel"));
    expect(state.remote.get("20001")?.[0]?.body).toBe(
      "*Written by Bo Osprey via Kestrel*\n\nLine two\r\nkeep *this*"
    );
    // Someone else's comment and the one without attribution are untouched.
    expect(state.remote.get("10001")?.[2]?.body).toEqual(
      cloudBody(attribution("Ann Heron", "Oldtool"))
    );
  });

  it("leaves the rest of the body unchanged", async () => {
    seed(true);
    const before = structuredClone(state.remote.get("10001")?.[0]?.body) as {
      content: unknown[];
    };
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    await step.apply(ctx(), item);
    const after = state.updates[0]?.body as { content: unknown[] };
    expect(JSON.stringify({ ...after, content: after.content.slice(1) })).toBe(
      JSON.stringify({ ...before, content: before.content.slice(1) })
    );
  });

  it("is idempotent", async () => {
    seed(true);
    for (const item of await step.plan(ctx())) await step.apply(ctx(), item);
    expect(await step.plan(ctx())).toEqual([]);
    // Applying a stale item again writes nothing.
    await step.apply(ctx(), {
      step: "jira",
      target: target(P1_ID, "10001", "c1"),
      from: "Written by Ann Heron via Oldtool",
      to: "Written by Ann Heron via Kestrel",
    });
    expect(state.updates).toHaveLength(3);
  });

  it("names Menara while the brand itself still carries the legacy name", async () => {
    seed(true);
    state.brand = "Oldtool Panel";
    const [item] = await step.plan(ctx());
    expect(item?.to).toBe("Written by Ann Heron via Menara Panel");
  });
});

describe("JiraClient comments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("updates a comment with PUT on the comment's path", async () => {
    const { JiraClient } =
      await vi.importActual<typeof import("@/lib/jira/client")>(
        "@/lib/jira/client"
      );
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        calls.push({
          url: String(url),
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(
          JSON.stringify({ id: "c1", body: "x", author: null }),
          { status: 200 }
        );
      })
    );
    const client = new JiraClient({
      baseUrl: "https://kestrel.example.test/",
      flavor: "datacenter",
      email: null,
      token: "fictional-pat",
    });
    await client.updateComment("20001", "c1", "*new*");
    expect((await client.getComment("20001", "c1")).id).toBe("c1");
    expect(calls).toEqual([
      {
        url: "https://kestrel.example.test/rest/api/2/issue/20001/comment/c1",
        method: "PUT",
        body: { body: "*new*" },
      },
      {
        url: "https://kestrel.example.test/rest/api/2/issue/20001/comment/c1",
        method: "GET",
        body: undefined,
      },
    ]);
  });
});
