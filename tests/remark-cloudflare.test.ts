import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Legacy } from "@/lib/legacy";
import type { RemarkContext } from "@/lib/remark/types";
import { fakeDb, type Row } from "./support/remark-db";

// The cloudflare step against a fake Cloudflare API (fetch stubbed): Access
// apps of the account, and DNS records per zone. Ours are the apps and
// records tagged `<legacy>:<envId>` for this instance's environments, and the
// records a locally-managed tunnel of this instance got with the comment
// "Managed by <Legacy> — <tunnel>".

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { encryptSecret } = await import("@/lib/secrets");
const step = await import("@/lib/remark/cloudflare");

const ENV1 = "0197f3a0-1b2c-7def-8000-0000000e0001";
const ENV2 = "0197f3a0-1b2c-7def-8000-0000000e0002";
const FOREIGN_ENV = "0197f3a0-1b2c-7def-8000-0000000e0999";
const ZONE_ROW = "0197f3a0-1b2c-7def-8000-0000000f0001";
const TUNNEL_ROW = "0197f3a0-1b2c-7def-8000-0000000f0002";
const ACCOUNT = "a".repeat(32);
const ZONE = "z".repeat(32);
const TOKEN = "FICTIONAL-CF-TOKEN";
const LOCAL_TUNNEL = "11111111-2222-3333-4444-555555555555";
const OTHER_TUNNEL = "99999999-2222-3333-4444-555555555555";

const LEGACY: Legacy = {
  name: "oldtool",
  upper: "OLDTOOL",
  title: "Oldtool",
  instance: "oldtool-beta",
};

type Record_ = {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  comment: string | null;
};

const cf = {
  apps: new Map<string, Record<string, unknown>>(),
  records: new Map<string, Record_[]>(),
  calls: [] as { method: string; path: string; body?: unknown }[],
  failZone: false,
};

function envelope(result: unknown, status = 200, info?: unknown) {
  return new Response(
    JSON.stringify({
      success: status < 400,
      errors: status < 400 ? [] : [{ code: 7003, message: "not found" }],
      result,
      result_info: info,
    }),
    { status }
  );
}

async function fakeFetch(url: string, init?: RequestInit) {
  const u = new URL(url);
  const path = u.pathname.replace("/client/v4", "");
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  cf.calls.push({ method, path, body });
  expect(new Headers(init?.headers).get("Authorization")).toBe(
    `Bearer ${TOKEN}`
  );
  const apps = /^\/accounts\/[a]+\/access\/apps(?:\/([^/]+))?$/.exec(path);
  if (apps) {
    const id = apps[1];
    if (!id) return envelope([...cf.apps.values()], 200, { total_pages: 1 });
    const app = cf.apps.get(id);
    if (!app) return envelope(null, 404);
    if (method === "PUT") {
      cf.apps.set(id, { ...body, id });
      return envelope(cf.apps.get(id));
    }
    return envelope(app);
  }
  const dns = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
  if (dns?.[1]) {
    if (cf.failZone) return envelope(null, 500);
    const records = cf.records.get(dns[1]) ?? [];
    const id = dns[2];
    if (!id) {
      const name = u.searchParams.get("name");
      const content = u.searchParams.get("content");
      return envelope(
        records.filter(
          (r) =>
            (name === null || r.name === name) &&
            (content === null || r.content === content)
        ),
        200,
        { total_pages: 1 }
      );
    }
    const record = records.find((r) => r.id === id);
    if (!record) return envelope(null, 404);
    if (method === "PATCH") Object.assign(record, body);
    return envelope(record);
  }
  throw new Error(`unexpected request ${method} ${path}`);
}

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

function record(
  id: string,
  content: string,
  comment: string | null,
  name = `${id}.example.net`
): Record_ {
  return { id, name, type: "CNAME", content, proxied: true, comment };
}

const target = (tunnel: string) => `${tunnel}.cfargotunnel.com`;

/** The legacy traces: one Access app, one tagged record, one tunnel record. */
function seedLegacy() {
  cf.apps.set("app1", {
    id: "app1",
    aud: "aud-1",
    name: `oldtool:${ENV1}`,
    domain: "kestrel.example.net",
    type: "self_hosted",
    allowed_idps: ["idp-1"],
    auto_redirect_to_identity: true,
    session_duration: "24h",
    self_hosted_domains: ["kestrel.example.net"],
    destinations: [{ type: "public", uri: "kestrel.example.net" }],
    tags: ["kestrel"],
    policies: [
      { id: "pol-1", precedence: 1, name: "Staff", decision: "allow" },
      { id: "pol-2", precedence: 2, name: "Bots", decision: "bypass" },
    ],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  cf.records.set(ZONE, [
    record(
      "rec1",
      target("remote-1"),
      `oldtool:${ENV1}`,
      "kestrel.example.net"
    ),
    record(
      "rec2",
      target(LOCAL_TUNNEL),
      "Managed by OldTool — apps-tunnel",
      "osprey.example.net"
    ),
    ...foreignRecords(),
  ]);
}

/** What is not ours or already converted. */
function foreignRecords(): Record_[] {
  return [
    // Another tunnel's record with the same comment.
    record("rec3", target(OTHER_TUNNEL), "Managed by OldTool — apps-tunnel"),
    // Our tunnel, a comment someone else wrote.
    record("rec4", target(LOCAL_TUNNEL), "hand made, oldtool era"),
    // Already the Menara form.
    record("rec5", target(LOCAL_TUNNEL), "Managed by Menara — apps-tunnel"),
  ];
}

function seedForeignApps() {
  cf.apps.set("app2", { id: "app2", name: `oldtool:${FOREIGN_ENV}` });
  cf.apps.set("app3", { id: "app3", name: `menara:${ENV2}` });
  cf.apps.set("app4", { id: "app4", name: "Staff wiki" });
}

beforeEach(() => {
  cf.apps = new Map();
  cf.records = new Map();
  cf.calls = [];
  cf.failZone = false;
  errors = [];
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  tables = {
    environments: [{ id: ENV1 }, { id: ENV2 }],
    cloudflare_accounts: [
      {
        id: "0197f3a0-1b2c-7def-8000-0000000f00aa",
        accountId: ACCOUNT,
        name: "Acme",
        apiToken: encryptSecret(TOKEN),
        accessIdpId: "idp-1",
      },
    ],
    cloudflare_zones: [
      { id: ZONE_ROW, name: "example.net", zoneId: ZONE, apiToken: null },
    ],
    environment_domains: [
      {
        environmentId: ENV1,
        kind: "tunnel",
        hostname: "kestrel.example.net",
        zoneId: ZONE_ROW,
        remoteTunnelId: "0197f3a0-1b2c-7def-8000-0000000f0003",
        accessAppId: "app1",
        dnsRecordId: "rec1",
      },
    ],
    tunnels: [
      {
        id: TUNNEL_ROW,
        zoneId: ZONE_ROW,
        serverId: "0197f3a0-1b2c-7def-8000-0000000000a1",
        name: "apps-tunnel",
        tunnelId: LOCAL_TUNNEL,
      },
    ],
  };
});
afterEach(() => vi.unstubAllGlobals());

const writes = () => cf.calls.filter((c) => c.method !== "GET");

describe("remark cloudflare", () => {
  it("plans nothing without legacy data", async () => {
    seedForeignApps();
    cf.records.set(ZONE, [
      record("rec1", target("remote-1"), `menara:${ENV1}`),
      ...foreignRecords(),
    ]);
    expect(await step.plan(ctx())).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("plans one item per legacy trace", async () => {
    seedLegacy();
    seedForeignApps();
    expect(await step.plan(ctx())).toEqual([
      {
        step: "cloudflare",
        target: "cloudflare/access-apps/app1",
        from: `oldtool:${ENV1}`,
        to: `menara:${ENV1}`,
      },
      {
        step: "cloudflare",
        target: `cloudflare/zones/${ZONE_ROW}/dns-records/rec1`,
        from: `oldtool:${ENV1}`,
        to: `menara:${ENV1}`,
      },
      {
        step: "cloudflare",
        target: `cloudflare/zones/${ZONE_ROW}/dns-records/rec2`,
        from: "Managed by OldTool — apps-tunnel",
        to: "Managed by Menara — apps-tunnel",
      },
    ]);
    expect(errors).toEqual([]);
    // A dry run only reads.
    expect(writes()).toEqual([]);
  });

  it("apply converts it", async () => {
    seedLegacy();
    for (const item of await step.plan(ctx())) await step.apply(ctx(), item);
    expect(cf.apps.get("app1")?.name).toBe(`menara:${ENV1}`);
    const records = cf.records.get(ZONE) ?? [];
    expect(records.find((r) => r.id === "rec1")?.comment).toBe(
      `menara:${ENV1}`
    );
    expect(records.find((r) => r.id === "rec2")?.comment).toBe(
      "Managed by Menara — apps-tunnel"
    );
    // Only the comment is sent for a record.
    expect(
      writes()
        .filter((c) => c.method === "PATCH")
        .map((c) => c.body)
    ).toEqual([
      { comment: `menara:${ENV1}` },
      { comment: "Managed by Menara — apps-tunnel" },
    ]);
  });

  it("writes an Access app back whole with only its name changed", async () => {
    seedLegacy();
    const fetched = structuredClone(cf.apps.get("app1"));
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    await step.apply(ctx(), item);
    const put = writes().find((c) => c.method === "PUT");
    expect(put?.path).toBe(`/accounts/${ACCOUNT}/access/apps/app1`);
    const {
      id: _id,
      aud: _aud,
      created_at: _c,
      updated_at: _u,
      policies: _p,
      ...kept
    } = fetched as Record<string, unknown>;
    // Every field as fetched, the name aside; policies as the references
    // the PUT takes, in order, with their precedence.
    expect(put?.body).toEqual({
      ...kept,
      name: `menara:${ENV1}`,
      policies: [
        { id: "pol-1", precedence: 1 },
        { id: "pol-2", precedence: 2 },
      ],
    });
    expect(Object.keys(put?.body as object).sort()).toEqual(
      [
        "allowed_idps",
        "auto_redirect_to_identity",
        "destinations",
        "domain",
        "name",
        "policies",
        "self_hosted_domains",
        "session_duration",
        "tags",
        "type",
      ].sort()
    );
  });

  it("refuses to write back an Access app without policies", async () => {
    seedLegacy();
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    const app = cf.apps.get("app1") as Record<string, unknown>;
    delete app.policies;
    await expect(step.apply(ctx(), item)).rejects.toThrow(/no policies/);
    expect(writes()).toEqual([]);
    expect(cf.apps.get("app1")?.name).toBe(`oldtool:${ENV1}`);
  });

  it("refuses an object renamed by someone else since the plan", async () => {
    seedLegacy();
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    cf.apps.set("app1", { id: "app1", name: "Hand renamed" });
    await expect(step.apply(ctx(), item)).rejects.toThrow(/no longer/);
    expect(writes()).toEqual([]);
  });

  it("reports a zone it cannot read and plans the rest", async () => {
    seedLegacy();
    cf.failZone = true;
    const items = await step.plan(ctx());
    expect(items.map((i) => i.target)).toEqual(["cloudflare/access-apps/app1"]);
    expect(errors.map((e) => e.target)).toEqual([
      `cloudflare/zones/${ZONE_ROW}`,
    ]);
    expect(JSON.stringify(errors)).not.toContain(TOKEN);
  });

  it("is idempotent", async () => {
    seedLegacy();
    seedForeignApps();
    const items = await step.plan(ctx());
    for (const item of items) await step.apply(ctx(), item);
    // A second apply of the same items changes nothing and does not fail.
    cf.calls = [];
    for (const item of items) await step.apply(ctx(), item);
    expect(writes()).toEqual([]);
    expect(await step.plan(ctx())).toEqual([]);
  });
});
