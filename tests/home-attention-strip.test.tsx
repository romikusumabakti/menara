// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import enRaw from "../messages/en.json";

const enMessages = applyBranding(enRaw, {
  appName: "Menara",
  companyName: null,
  allowedEmailDomain: "example.com",
});

const api = vi.hoisted(() => ({
  attention: (() => new Promise(() => {})) as () => Promise<unknown>,
}));
vi.mock("@/web/api/home", () => ({
  getAttentionGroupsQuery: () => ({
    queryKey: ["home", "getAttentionGroups", []],
    queryFn: () => api.attention(),
  }),
  getInstanceBackupAttentionQuery: () => ({
    queryKey: ["home", "getInstanceBackupAttention"],
    queryFn: () => new Promise(() => {}),
  }),
  acknowledgeAttentionGroup: vi.fn(),
  unacknowledgeRuns: vi.fn(),
}));
vi.mock("@/web/api/instance", () => ({ acknowledgeInstanceBackup: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  Link: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/web/routes/$locale/_app/-components/home/home-issue-dialog", () => ({
  useIssueDialog: () => ({ open: vi.fn(), canCreateIn: () => true }),
}));

import { AttentionStrip } from "@/web/routes/$locale/_app/-components/home/attention-strip";

const ATTENTION_KEY = ["home", "getAttentionGroups", []];
const BACKUP_KEY = ["home", "getInstanceBackupAttention"];

const GROUP = {
  environmentId: "env-1",
  environmentName: "ACME staging",
  projectId: "p1",
  key: "deploy",
  envPath: "/projects/ACME/environments/staging",
  count: 3,
  canAcknowledge: true,
  latest: {
    kind: "deploy",
    description: "Deploy",
    errorMessage: null,
    runAt: new Date().toISOString(),
  },
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

beforeEach(() => {
  api.attention = () => new Promise(() => {});
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={enMessages} timeZone="UTC">
          <AttentionStrip />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

describe("home attention strip", () => {
  it("renders nothing while loading", async () => {
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when there is nothing to attend to (no All clear line)", async () => {
    queryClient.setQueryData(ATTENTION_KEY, []);
    queryClient.setQueryData(BACKUP_KEY, null);
    await render();
    expect(container.innerHTML).toBe("");
    expect(container.textContent).not.toContain("All clear");
  });

  it("lists failures with the count and the Issue and Ack actions", async () => {
    queryClient.setQueryData(ATTENTION_KEY, [GROUP]);
    queryClient.setQueryData(BACKUP_KEY, null);
    await render();
    const strip = container.querySelector('[data-slot="card"]');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("Deploy · ACME staging");
    expect(strip?.textContent).toContain("×3");
    expect(strip?.textContent).toContain("Issue");
    expect(strip?.textContent).toContain("Ack");
    // No header or total.
    expect(strip?.textContent).not.toContain("Needs attention");
  });

  it("shows the stale instance backup item on its own", async () => {
    queryClient.setQueryData(ATTENTION_KEY, []);
    queryClient.setQueryData(BACKUP_KEY, { kind: "stale", at: null });
    await render();
    expect(container.textContent).toContain(
      enMessages.homePage.attention.instanceBackupStale
    );
  });

  it("shows a compact error strip when the failures cannot be loaded", async () => {
    api.attention = () => Promise.reject(new Error("boom"));
    queryClient.setQueryData(BACKUP_KEY, null);
    await render();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toContain(enMessages.homePage.error.load);
    expect(container.textContent).toContain(enMessages.homePage.error.retry);
  });
});
