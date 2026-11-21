// An in-memory stand-in for the drizzle `db` the remark steps take on their
// context: tables are arrays of rows keyed by SQL table name; select (with or
// without a projection), where, limit, for, update … set … where … returning
// and transaction behave like the real chain for the conditions faked by
// fakeDrizzleOperators (eq, ne, and, or, isNull, isNotNull).

export type Row = Record<string, unknown>;

export type Cond =
  | { op: "eq" | "ne"; key: string; value: unknown }
  | { op: "isNull" | "isNotNull"; key: string }
  | { op: "and" | "or"; conds: Cond[] };

export const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

const isColumn = (c: unknown): c is { name: string } =>
  typeof (c as { name?: unknown } | null)?.name === "string";

/** For `vi.mock("drizzle-orm", (orig) => fakeDrizzleOperators(orig))`. */
export async function fakeDrizzleOperators(
  importOriginal: () => Promise<unknown>
) {
  const actual = (await importOriginal()) as typeof import("drizzle-orm");
  return {
    ...actual,
    eq: (column: unknown, value: unknown) =>
      isColumn(column)
        ? { op: "eq", key: camel(column.name), value }
        : actual.eq(column as never, value),
    ne: (column: unknown, value: unknown) =>
      isColumn(column)
        ? { op: "ne", key: camel(column.name), value }
        : actual.ne(column as never, value),
    isNull: (column: unknown) =>
      isColumn(column)
        ? { op: "isNull", key: camel(column.name) }
        : actual.isNull(column as never),
    isNotNull: (column: unknown) =>
      isColumn(column)
        ? { op: "isNotNull", key: camel(column.name) }
        : actual.isNotNull(column as never),
    and: (...conds: unknown[]) => ({ op: "and", conds }),
    or: (...conds: unknown[]) => ({ op: "or", conds }),
  };
}

function matches(row: Row, cond: Cond | undefined): boolean {
  if (!cond) return true;
  switch (cond.op) {
    case "eq":
      return row[cond.key] === cond.value;
    case "ne":
      return row[cond.key] != null && row[cond.key] !== cond.value;
    case "isNull":
      return row[cond.key] == null;
    case "isNotNull":
      return row[cond.key] != null;
    case "or":
      return cond.conds.some((c) => matches(row, c));
    case "and":
      return cond.conds.every((c) => matches(row, c));
  }
}

const tableName = (table: unknown) =>
  String((table as { [k: symbol]: unknown })[Symbol.for("drizzle:Name")]);

function query(run: () => Row[]) {
  const result = {
    limit: async () => run(),
    for: async () => run(),
    returning: async () => run(),
    // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle query
    then: (ok: (rows: Row[]) => unknown, fail: (e: unknown) => unknown) =>
      Promise.resolve().then(run).then(ok, fail),
  };
  return result;
}

export function fakeDb(tables: Record<string, Row[]>) {
  const rowsOf = (table: unknown) => {
    const name = tableName(table);
    tables[name] ??= [];
    return tables[name];
  };
  const project =
    (fields: Record<string, unknown> | undefined) => (row: Row) => {
      if (!fields) return { ...row };
      const out: Row = {};
      for (const [alias, column] of Object.entries(fields)) {
        out[alias] = isColumn(column) ? row[camel(column.name)] : undefined;
      }
      return out;
    };
  const db = {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const all = () => rowsOf(table).map(project(fields));
        return {
          ...query(all),
          where: (cond: Cond) =>
            query(() =>
              rowsOf(table)
                .filter((r) => matches(r, cond))
                .map(project(fields))
            ),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: (cond: Cond) =>
          query(() => {
            const hit = rowsOf(table).filter((r) => matches(r, cond));
            for (const r of hit) Object.assign(r, values);
            return hit.map((r) => ({ ...r }));
          }),
      }),
    }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };
  return db as never;
}
