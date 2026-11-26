// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const state = vi.hoisted(() => ({
  role: "admin",
  collections: [] as unknown[],
  items: [] as unknown[],
}));

vi.mock("@/i18n/navigation", () => ({
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
vi.mock("@/web/api/session", () => ({
  useMe: () => ({ orgRole: state.role }),
}));
vi.mock("@/web/api/knowledge", () => ({
  listCollectionsQuery: () => ({
    queryKey: ["collections"],
    queryFn: async () => state.collections,
  }),
  recentKnowledgeQuery: () => ({
    queryKey: ["recent"],
    queryFn: async () => ({ items: state.items }),
  }),
}));
vi.mock("@/components/knowledge-search", () => ({
  KnowledgeSearchTrigger: ({ variant }: { variant: string }) => (
    <div data-testid={`trigger-${variant}`} />
  ),
}));

import { Route } from "../web/routes/$locale/_app/knowledge.index";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  const Home = Route.options.component as React.ComponentType;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={messages}>
          <Suspense fallback={null}>
            <Home />
          </Suspense>
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  await act(async () => {});
}

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  state.role = "admin";
  state.collections = [];
  state.items = [];
});

const COLLECTION = { id: "c1", name: "ACME" };

describe("knowledge landing", () => {
  it("keeps the no-collections empty state", async () => {
    await render();
    expect(container.textContent).toContain(messages.knowledge.emptyTitle);
    expect(container.querySelector('[data-testid="trigger-hero"]')).toBeNull();
  });

  it("lists recent documents as single links with collection, editor and time", async () => {
    state.collections = [COLLECTION];
    state.items = [
      {
        slug: "runbook",
        title: "Runbook",
        docType: "doc",
        collection: { id: "c1", name: "ACME" },
        editedAt: new Date().toISOString(),
        editedBy: { id: "u1", name: "Alex" },
      },
      {
        slug: "notes",
        title: "Notes",
        docType: "doc",
        collection: { id: "c1", name: "ACME" },
        editedAt: new Date().toISOString(),
        editedBy: null,
      },
    ];
    await render();
    expect(
      container.querySelector('[data-testid="trigger-hero"]')
    ).not.toBeNull();
    expect(container.textContent).toContain(messages.knowledge.recentTitle);
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/knowledge/runbook",
      "/knowledge/notes",
    ]);
    expect(links[0]?.querySelector("a")).toBeNull();
    expect(links[0]?.textContent).toMatch(/^Runbook\s*ACME · Alex · /);
    expect(links[1]?.textContent).toMatch(/^Notes\s*ACME · (?!.*Alex)/);
  });

  it("offers New document to writers when nothing is published yet", async () => {
    state.collections = [COLLECTION];
    await render();
    expect(container.textContent).toContain(messages.knowledge.recentEmptyHint);
    expect(
      container.querySelector('a[href="/knowledge/new"]')?.textContent
    ).toContain(messages.knowledge.newDocument);
  });

  it("scrolls on its own and keeps the page side padding", async () => {
    state.collections = [COLLECTION];
    await render();
    const scroller = container.firstElementChild as HTMLElement;
    const cls = [...scroller.classList];
    expect(cls).toEqual(
      expect.arrayContaining([
        "h-full",
        "overflow-y-auto",
        "px-4",
        "sm:px-6",
        "lg:px-8",
      ])
    );
  });

  it("matches the assistant landing block: max-w-3xl, centred vertically, list at the search width", async () => {
    state.collections = [COLLECTION];
    await render();
    const scroller = container.firstElementChild as HTMLElement;
    const column = scroller.firstElementChild as HTMLElement;
    expect([...column.classList]).toEqual(
      expect.arrayContaining([
        "max-w-3xl",
        "min-h-full",
        "justify-center",
        "gap-6",
        "pb-[12vh]",
      ])
    );
    expect([...column.classList]).not.toContain("max-w-2xl");
  });

  it("has its own pending skeleton instead of the app-wide spinner", async () => {
    expect(Route.options.pendingComponent).toBeTypeOf("function");
    const Pending = Route.options.pendingComponent as React.ComponentType;
    const holder = document.createElement("div");
    document.body.append(holder);
    const r = createRoot(holder);
    await act(async () => r.render(<Pending />));
    const scroller = holder.firstElementChild as HTMLElement;
    expect(scroller.classList).toContain("overflow-y-auto");
    expect([...(scroller.firstElementChild?.classList ?? [])]).toEqual(
      expect.arrayContaining(["max-w-3xl", "min-h-full", "justify-center"])
    );
    await act(async () => r.unmount());
    holder.remove();
  });

  it("shows no New document button to readers", async () => {
    state.role = "staff";
    state.collections = [COLLECTION];
    await render();
    expect(container.textContent).toContain(messages.knowledge.recentEmptyHint);
    expect(container.querySelector('a[href="/knowledge/new"]')).toBeNull();
  });
});
