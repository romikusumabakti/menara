import { readFileSync } from "node:fs";
import type { BetterAuthOptions } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { getTableColumns, type Table } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// The schema the MCP server needs: the OAuth tables better-auth's jwt, mcp
// and cimd plugins write, the instance switch, and the `demo` kind.

vi.mock("@/lib/db", () => ({ db: {}, pgClient: vi.fn() }));

const { auth, authSchema } = await import("@/lib/auth");
const { environmentKindEnum, instanceSettings } = await import(
  "@/lib/db/schema"
);

describe("the MCP schema", () => {
  it("maps every better-auth model the MCP plugins need to a Drizzle table", () => {
    const tables = getAuthTables(auth.options as BetterAuthOptions);
    const schema = authSchema as Record<string, Table>;

    for (const [key, model] of Object.entries(tables)) {
      // usePlural: the drizzle adapter looks a model up by its name plus "s".
      const table = schema[`${model.modelName}s`];
      if (!table) throw new Error(`model ${key} has no Drizzle table`);
      const columns = getTableColumns(table);
      expect(columns.id, `${key}.id`).toBeDefined();
      for (const [field, attr] of Object.entries(model.fields)) {
        const name = attr.fieldName ?? field;
        expect(columns[name], `${key}.${name}`).toBeDefined();
      }
    }
    // The MCP models in particular, so a plugin set that silently drops
    // them cannot pass.
    for (const model of [
      "jwks",
      "oauthClient",
      "oauthResource",
      "oauthClientResource",
      "oauthRefreshToken",
      "oauthAccessToken",
      "oauthConsent",
      "oauthClientAssertion",
    ]) {
      expect(Object.keys(tables)).toContain(model);
    }
  });

  it("adds demo to environment kinds", () => {
    expect(environmentKindEnum.enumValues).toEqual([
      "qa",
      "dev",
      "release",
      "sandbox",
      "prod",
      "demo",
    ]);
  });

  it("labels demo in every locale", () => {
    const expected: Record<string, string> = {
      en: "Demo",
      id: "Demo",
      es: "Demo",
      zh: "演示",
      ar: "عرض توضيحي",
    };
    for (const [locale, label] of Object.entries(expected)) {
      const m = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));
      expect(m.environmentKinds.demo, locale).toBe(label);
    }
  });

  it("defaults the MCP switch off", () => {
    const column = getTableColumns(instanceSettings).mcpEnabled;
    expect(column).toBeDefined();
    expect(column.notNull).toBe(true);
    expect(column.hasDefault).toBe(true);
    expect(column.default).toBe(false);
  });
});
