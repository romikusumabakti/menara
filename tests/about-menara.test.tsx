// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import { releaseNotesUrl, UPSTREAM_REPO_URL } from "@/lib/upstream";
import enMessages from "../messages/en.json";

const state = vi.hoisted(() => ({
  bootstrap: { appName: "Kestrel Ops", companyName: "PT Kestrel Osprey" } as {
    appName: string;
    companyName: string | null;
  },
  version: "1.2.3",
}));

vi.mock("@/web/api/session", () => ({
  useBootstrap: () => ({ ...state.bootstrap, logo: null }),
}));
vi.mock("@/web/api/about", () => ({
  getAboutQuery: () => ({
    queryKey: ["about"],
    queryFn: async () => ({ version: state.version }),
  }),
}));

import { AboutDialog } from "@/components/about-dialog";
import { Copyright } from "@/components/copyright";

let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  document.body.innerHTML = "";
});

async function render(node: React.ReactNode) {
  const messages = applyBranding(enMessages, {
    ...state.bootstrap,
    allowedEmailDomain: "example.com",
  });
  const el = document.createElement("div");
  document.body.append(el);
  container = el;
  const r = createRoot(el);
  root = r;
  const client = new QueryClient();
  await act(async () =>
    r.render(
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          {node}
        </IntlProvider>
      </QueryClientProvider>
    )
  );
  // Let the about query resolve.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("releaseNotesUrl", () => {
  it("points a release at its tag and a dev build at the list", () => {
    expect(releaseNotesUrl("0.9.1")).toBe(
      `${UPSTREAM_REPO_URL}/releases/tag/v0.9.1`
    );
    expect(releaseNotesUrl("0.10.0-beta.1")).toBe(
      `${UPSTREAM_REPO_URL}/releases/tag/v0.10.0-beta.1`
    );
    expect(releaseNotesUrl("0.0.0-dev")).toBe(`${UPSTREAM_REPO_URL}/releases`);
  });
});

describe("Copyright", () => {
  it("credits Menara with a link to its repository on a rebranded instance", async () => {
    state.bootstrap = { appName: "Kestrel Ops", companyName: "PT Kestrel" };
    await render(<Copyright />);
    const year = new Date().getFullYear();
    expect(container?.textContent).toBe(
      `© ${year} PT Kestrel · Powered by Menara`
    );
    const link = container?.querySelector("a");
    expect(link?.textContent).toBe("Menara");
    expect(link?.getAttribute("href")).toBe(UPSTREAM_REPO_URL);
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  it("links the name itself on an unbranded instance", async () => {
    state.bootstrap = { appName: "Menara", companyName: null };
    await render(<Copyright />);
    expect(container?.textContent).toBe(`© ${new Date().getFullYear()} Menara`);
    expect(container?.querySelector("a")?.getAttribute("href")).toBe(
      UPSTREAM_REPO_URL
    );
  });
});

describe("AboutDialog", () => {
  function links() {
    return [...document.querySelectorAll("a")].map((a) => ({
      text: a.textContent,
      href: a.getAttribute("href"),
    }));
  }

  it("names Menara, the instance, the version and the upstream links", async () => {
    state.bootstrap = { appName: "Kestrel Ops", companyName: "PT Kestrel" };
    state.version = "1.2.3";
    await render(<AboutDialog open onOpenChange={() => {}} />);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector("h2")?.textContent).toBe("Menara");
    expect(dialog?.textContent).toContain(
      "Kestrel Ops runs on Menara, open-source software."
    );
    expect(dialog?.textContent).toContain("MIT");
    expect(links()).toEqual([
      { text: "1.2.3", href: `${UPSTREAM_REPO_URL}/releases/tag/v1.2.3` },
      { text: "Report an issue", href: `${UPSTREAM_REPO_URL}/issues` },
      { text: "Source code", href: UPSTREAM_REPO_URL },
    ]);
  });

  it("shows a dev build without a release link and skips the runs-on line when unbranded", async () => {
    state.bootstrap = { appName: "Menara", companyName: null };
    state.version = "0.0.0-dev";
    await render(<AboutDialog open onOpenChange={() => {}} />);
    const dialog = document.querySelector('[role="dialog"]');
    expect(
      dialog?.querySelector('[data-slot="about-version"]')?.textContent
    ).toBe("Development build");
    expect(dialog?.textContent).not.toContain("runs on Menara");
  });
});
