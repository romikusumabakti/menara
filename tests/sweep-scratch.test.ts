import { spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import {
  drizzleScanColumn,
  ROW_LIMIT,
  scanDatabase,
} from "@/lib/sweep/db-scan";

// The sweep's real database query against a real Postgres. It creates a
// scratch database in a Postgres reachable through SWEEP_SCRATCH_URL (a
// superuser URL to the `postgres` database), migrates it with `menara
// migrate` and drops it afterwards.
//
//   podman run -d --rm --name sweep-pg -p 127.0.0.1:55434:5432 -e POSTGRES_PASSWORD=postgres docker.io/library/postgres:18
//   SWEEP_SCRATCH_URL=postgres://postgres:postgres@127.0.0.1:55434 bun --bun vitest run tests/sweep-scratch.test.ts
const base = process.env.SWEEP_SCRATCH_URL;
const DB_NAME = "sweep_scratch";
const legacy = {
  name: "oldtool",
  upper: "OLDTOOL",
  title: "Oldtool",
  instance: null,
};

describe.skipIf(!base)("sweep database scan on a real Postgres", () => {
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  const url = `${base}/${DB_NAME}`;

  beforeAll(async () => {
    admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    const result = spawnSync("bun", ["scripts/cli.ts", "migrate"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: url,
      },
    });
    if (result.status !== 0)
      throw new Error(`migrate failed: ${result.stderr}`);
    client = postgres(url, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await client?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin?.end();
  });

  it("finds whole-word hits in text, jsonb and composite-key tables", async () => {
    const db = drizzle({ client }) as never;
    const d = drizzle({ client });
    const [user] = await d
      .insert(schema.users)
      .values({
        id: "00000000-0000-7000-8000-00000000f001",
        name: "Wulan",
        email: "qa@example.invalid",
        role: "qa",
      })
      .returning();
    if (!user) throw new Error("user");
    const [project] = await d
      .insert(schema.projects)
      .values({ name: "Kestrel", key: "KST" })
      .returning();
    if (!project) throw new Error("project");
    await d.insert(schema.issues).values([
      // Percent and underscore must not act as wildcards; a substring is no hit.
      {
        projectId: project.id,
        number: 1,
        title: "migrate from Oldtool 100%",
        createdById: user.id,
      },
      {
        projectId: project.id,
        number: 2,
        title: "oldtoolkit is unrelated",
        createdById: user.id,
      },
      {
        projectId: project.id,
        number: 3,
        title: "old_tool is unrelated",
        createdById: user.id,
      },
    ]);
    await d.insert(schema.savedViews).values({
      userId: user.id,
      name: "mine",
      params: { q: "oldtool-beta" },
    });

    const hits = await scanDatabase(db, legacy);
    const locations = hits.map((h) => h.location);
    expect(locations.filter((l) => l.startsWith("issues.title"))).toHaveLength(
      1
    );
    expect(
      hits.find((h) => h.location.startsWith("issues.title"))?.excerpt
    ).toBe("migrate from Oldtool 100%");
    expect(locations.some((l) => l.startsWith("saved_views.params ("))).toBe(
      true
    );
    expect(hits.every((h) => !h.excerpt.startsWith("could not check"))).toBe(
      true
    );
  });

  it("returns at most ROW_LIMIT + 1 rows for a column", async () => {
    const db = drizzle({ client }) as never;
    await client.unsafe(
      `INSERT INTO labels (name, color) SELECT 'oldtool ' || g, 'red' FROM generate_series(1, ${ROW_LIMIT + 5}) g`
    );
    const read = drizzleScanColumn(db, legacy);
    const rows = await read({
      table: "labels",
      column: "name",
      idColumns: ["id"],
    });
    expect(rows).toHaveLength(ROW_LIMIT + 1);
    const hits = await scanDatabase(db, legacy);
    expect(hits.filter((h) => h.location === "labels.name")).toEqual([
      expect.objectContaining({
        excerpt: expect.stringContaining("could not check: truncated"),
      }),
    ]);
  });
});
