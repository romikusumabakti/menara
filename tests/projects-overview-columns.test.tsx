// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// The Projects page layout: one column of cards, each environment row a CSS
// grid with aligned columns from xl.

vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/projects",
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ProjectsOverview } from "@/components/projects-overview";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LONG_DB = "acme_reporting_warehouse_primary_replica_2026";
const env = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  slug: "dev",
  name: "Proj AAA Dev",
  kind: "dev",
  url: "https://dev.example.com",
  dbType: "postgresql",
  dbName: LONG_DB,
  owner: {
    id: "u9",
    name: "Alice Example Longname",
    image: null,
    banned: false,
  },
  ...over,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <ProjectsOverview
          projects={
            [
              {
                id: "p-AAA",
                key: "AAA",
                name: "Proj AAA",
                groupId: null,
                client: null,
                environments: [
                  env(),
                  env({
                    id: "e2",
                    slug: "bare",
                    url: null,
                    dbType: null,
                    dbName: null,
                    owner: null,
                  }),
                ],
              },
            ] as never
          }
          groups={[]}
          userId="u1"
          openIssueCounts={{}}
          lastActivity={{}}
          lastOpened={{}}
          initialSort="name_asc"
          projectRoles={{}}
        />
      </IntlProvider>
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const rows = () => [
  ...container.querySelectorAll<HTMLElement>("li > div.group"),
];
const rowAt = (i: number) => {
  const r = rows()[i];
  if (!r) throw new Error(`row ${i} missing`);
  return r;
};

describe("ProjectsOverview columns", () => {
  it("lists projects in one column", () => {
    const grid = container.querySelector("div.grid");
    expect(grid?.className).not.toContain("xl:grid-cols-2");
    expect(grid?.className).toContain("grid-cols-1");
  });

  it("turns each environment row into an aligned grid from xl", () => {
    const row = rowAt(0);
    expect(row.className).toContain("xl:grid");
    const m = row.className.match(/xl:grid-cols-\[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const tracks = (m?.[1] ?? "").split("_");
    expect(tracks).toContain("minmax(0,1fr)");
    // dot + name + DB type + DB name + owner + activity
    expect(tracks).toHaveLength(6);
    // every row emits the same number of grid cells, so columns stay aligned
    const cells = (r: Element) =>
      [...r.children].flatMap((c) =>
        c.className.includes("xl:contents") ? [...c.children] : [c]
      );
    expect(cells(rowAt(1))).toHaveLength(cells(rowAt(0)).length);
  });

  it("truncates the DB name and owner with the full value in title", () => {
    const db = container.querySelector(`code[title="${LONG_DB}"]`);
    expect(db?.className).toContain("truncate");
    const owner = container.querySelector('[title="Alice Example Longname"]');
    expect(owner?.querySelector(".truncate")?.textContent).toBe(
      "Alice Example Longname"
    );
  });

  it("drops the 40% host cap and caps the name at 60% only with a host", () => {
    expect(container.innerHTML).not.toContain("max-w-[40%]");
    const links = [
      ...container.querySelectorAll('a[href="/AAA/dev"], a[href="/AAA/bare"]'),
    ];
    expect(links[0]?.className).toContain("max-w-[60%]");
    expect(links[1]?.className).not.toContain("max-w-[60%]");
    expect(links[1]?.className).toContain("min-w-0");
  });
});
