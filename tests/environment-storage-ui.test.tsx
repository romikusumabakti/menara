// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import arMessages from "../messages/ar.json";
import enMessages from "../messages/en.json";
import esMessages from "../messages/es.json";
import idMessages from "../messages/id.json";
import zhMessages from "../messages/zh.json";

// Storage per environment, browser side: the Storage page (the explorer, or
// a not-configured state), the old per-connection URLs, and the removed
// global /storage URLs.

const mocks = vi.hoisted(() => ({
  confirmTyping: vi.fn(),
  explorer: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/dialog-provider", () => ({
  useDialog: () => ({ confirm: vi.fn(), confirmTyping: mocks.confirmTyping }),
}));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/file-explorer", () => ({
  FileExplorer: (props: unknown) => {
    mocks.explorer(props);
    return <div data-testid="explorer" />;
  },
}));

import { ApiError } from "@/web/api/client";
import { environmentStorageQuery } from "@/web/api/environment-storage";
import { s3ConnectionLocationQuery } from "@/web/api/s3-connections";
import { meQuery } from "@/web/api/session";
import { StorageExplorerPage } from "../web/routes/$locale/_app/-components/env/storage/storage-page";
import { Route as EnvFiles } from "../web/routes/$locale/_app/$projectKey.$envSlug.storage.$connectionId.files";
import { Route as EnvConnection } from "../web/routes/$locale/_app/$projectKey.$envSlug.storage.$connectionId.index";
import { Route as EnvStorage } from "../web/routes/$locale/_app/$projectKey.$envSlug.storage.index";
import { Route as OldFiles } from "../web/routes/$locale/_app/storage.$id.files";
import { Route as OldConnection } from "../web/routes/$locale/_app/storage.$id.index";
import { Route as OldIndex } from "../web/routes/$locale/_app/storage.index";
import { Route as OldNew } from "../web/routes/$locale/_app/storage.new";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ENV_ID = "0197f3a0-1b2c-7def-8000-0000000000e1";
const CONN_ID = "0197f3a0-1b2c-7def-8000-0000000000c1";

const storage = (over: Record<string, unknown> = {}) => ({
  environmentId: ENV_ID,
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "assets",
  keyPrefix: "team-a/",
  accessKeyId: "AKIAEXAMPLE",
  forcePathStyle: true,
  hasSecret: true,
  isBackupDestination: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(
  ui: React.ReactNode,
  queryClient: QueryClient = new QueryClient()
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={enMessages} timeZone="UTC">
          {ui}
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
});

const hrefs = () =>
  [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));

function pageClient(
  config: ReturnType<typeof storage> | null,
  orgRole = "engineer"
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(environmentStorageQuery(ENV_ID).queryKey, config);
  queryClient.setQueryData(meQuery().queryKey, { id: "u1", orgRole } as never);
  return queryClient;
}

const page = (props: { canManage: boolean }) => (
  <StorageExplorerPage
    environmentId={ENV_ID}
    settingsHref="/HMEM/dev/settings?tab=storage"
    {...props}
  />
);

describe("environment storage page", () => {
  it("is the explorer on the environment's storage", async () => {
    await render(page({ canManage: true }), pageClient(storage()));
    expect(document.querySelector("[data-testid=explorer]")).not.toBeNull();
    expect(mocks.explorer).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "s3", environmentId: ENV_ID },
      })
    );
  });

  it("says nothing is configured, with a Settings link only for a manager", async () => {
    await render(page({ canManage: true }), pageClient(null));
    expect(document.querySelector("[data-testid=explorer]")).toBeNull();
    expect(container.textContent).toContain(
      enMessages.storage.notConfiguredTitle
    );
    expect(hrefs()).toContain("/HMEM/dev/settings?tab=storage");
    act(() => root.unmount());
    container.remove();
    await render(page({ canManage: false }), pageClient(null));
    expect(container.textContent).toContain(
      enMessages.storage.notConfiguredTitle
    );
    expect(hrefs()).not.toContain("/HMEM/dev/settings?tab=storage");
  });

  it("shows the restricted message instead of the explorer on the backup bucket for an engineer", async () => {
    await render(
      page({ canManage: true }),
      pageClient(storage({ isBackupDestination: true }))
    );
    expect(document.querySelector("[data-testid=explorer]")).toBeNull();
    expect(container.textContent).toContain(enMessages.storage.restrictedTitle);
  });

  it("opens the explorer on the backup bucket for an org role with storage files", async () => {
    await render(
      page({ canManage: true }),
      pageClient(storage({ isBackupDestination: true }), "infra")
    );
    expect(document.querySelector("[data-testid=explorer]")).not.toBeNull();
  });
});

describe("environment storage page guards", () => {
  type Guard = (ctx: unknown) => unknown;
  const guard = (route: { options: { beforeLoad?: unknown } }, role: string) =>
    (route.options.beforeLoad as Guard)({
      context: { role },
      params: { locale: "en", projectKey: "HMEM", envSlug: "dev" },
    });

  it("browsing is a 404 without variable read", () => {
    for (const role of ["viewer", "qa"]) {
      try {
        guard(EnvStorage, role);
        throw new Error("opened");
      } catch (error) {
        expect(isNotFound(error)).toBe(true);
      }
    }
    expect(() => guard(EnvStorage, "engineer")).not.toThrow();
  });

  it.each([
    ["the connection page", EnvConnection],
    ["the connection's files", EnvFiles],
  ])("%s redirects to the environment's Storage page", (_name, route) => {
    try {
      guard(route, "engineer");
      throw new Error("no redirect");
    } catch (error) {
      expect(isRedirect(error)).toBe(true);
      expect((error as { options: { href: string } }).options.href).toBe(
        "/en/HMEM/dev/storage"
      );
    }
  });
});

describe("Admin › Storage", () => {
  it("is not a route any more", () => {
    const routeTree = readFileSync("web/routeTree.gen.ts", "utf8");
    expect(routeTree).not.toContain("admin/storage");
    expect(routeTree).not.toContain("AdminStorage");
  });
});

describe("removed global /storage URLs", () => {
  /**
   * A query client serving the caller's role and the server's answer for
   * the connection's location (a value, or a function that throws).
   */
  function context(orgRole: string, location: unknown | (() => never)) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(meQuery().queryKey, {
      id: "u1",
      orgRole,
    } as never);
    if (typeof location === "function") {
      queryClient.query = (async (options: { queryKey: unknown }) => {
        if (
          JSON.stringify(options.queryKey).includes("getS3ConnectionLocation")
        ) {
          return (location as () => never)();
        }
        return queryClient.fetchQuery(options as never);
      }) as never;
    } else {
      queryClient.setQueryData(
        s3ConnectionLocationQuery(CONN_ID).queryKey,
        location as never
      );
    }
    return { queryClient };
  }

  type Loader = (ctx: unknown) => unknown;
  async function outcome(
    route: { options: { beforeLoad?: unknown } },
    params: object,
    ctx: object
  ): Promise<string> {
    try {
      await (route.options.beforeLoad as Loader)({
        params: { locale: "en", ...params },
        context: ctx,
      });
    } catch (error) {
      if (isRedirect(error)) return String(error.options.href);
      if (isNotFound(error)) return "not-found";
      throw error;
    }
    return "no-redirect";
  }

  const inEnvironment = {
    kind: "environment",
    projectKey: "HMEM",
    envSlug: "dev",
  };

  it("an assigned connection's page and files go to its environment's Storage page, for any role that sees it", async () => {
    // The server answers by the environment, not the org role.
    for (const role of ["admin", "engineer", "qa"]) {
      for (const route of [OldConnection, OldFiles]) {
        expect(
          await outcome(route, { id: CONN_ID }, context(role, inEnvironment))
        ).toBe("/en/HMEM/dev/storage");
      }
    }
  });

  it("a connection the server does not show the caller is not found", async () => {
    for (const status of [400, 403, 404]) {
      const ctx = context("engineer", () => {
        throw new ApiError(status, "Not Found");
      });
      expect(await outcome(OldConnection, { id: CONN_ID }, ctx)).toBe(
        "not-found"
      );
      expect(await outcome(OldFiles, { id: CONN_ID }, ctx)).toBe("not-found");
    }
  });

  it("the old list and create URLs go to the projects page", async () => {
    for (const route of [OldIndex, OldNew]) {
      for (const role of ["admin", "engineer"]) {
        expect(await outcome(route, {}, context(role, null))).toBe(
          "/en/projects"
        );
      }
    }
  });
});

describe("storage messages", () => {
  const locales = {
    en: enMessages,
    id: idMessages,
    ar: arMessages,
    es: esMessages,
    zh: zhMessages,
  } as Record<string, Record<string, Record<string, unknown>>>;
  const namespaces = ["storage", "s3Form"];

  it.each(Object.keys(locales))(
    "%s has every key of the English storage namespaces",
    (locale) => {
      for (const ns of namespaces) {
        expect(Object.keys(locales[locale]?.[ns] ?? {}).sort()).toEqual(
          Object.keys(locales.en?.[ns] ?? {}).sort()
        );
      }
      expect(locales[locale]?.breadcrumbs?.storage).toBeTypeOf("string");
    }
  );
});
