// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRoleProvider } from "@/components/project-role";
import messages from "../messages/en.json";

type State = {
  lock: {
    lockedBy: { id: string; name: string } | null;
    reason: string;
    expiresAt: string;
  } | null;
  heldCount: number;
};

const mock = vi.hoisted(() => ({
  state: { lock: null, heldCount: 0 } as State,
  orgRole: "member" as string,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/web/api/deploy-locks", () => ({
  getDeployLockQuery: (id: string) => ({
    queryKey: ["deploy-locks", "getDeployLock", id],
    queryFn: async () => mock.state,
  }),
  lockEnvironment: vi.fn(),
  unlockEnvironment: vi.fn(),
  forceUnlockEnvironment: vi.fn(),
}));
vi.mock("@/web/api/session", () => ({
  meQuery: () => ({
    queryKey: ["me"],
    queryFn: async () => ({ user: { id: "u-me" }, orgRole: mock.orgRole }),
  }),
}));

import { DeployLockControl } from "../web/routes/$locale/_app/-components/env/deploys/deploy-lock";

const l = messages.deploys.lock;
let root: Root;
let container: HTMLDivElement;

async function mount(o: {
  role?: "viewer" | "engineer";
  ownerId?: string | null;
  orgRole?: string;
  state: State;
}) {
  mock.state = o.state;
  mock.orgRole = o.orgRole ?? "member";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ProjectRoleProvider role={o.role ?? "engineer"}>
            <DeployLockControl environmentId="e1" ownerId={o.ownerId ?? null} />
          </ProjectRoleProvider>
        </IntlProvider>
      </QueryClientProvider>
    )
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const buttons = () => [...container.querySelectorAll("button")];
const named = (text: string) =>
  buttons().find((b) => b.textContent?.trim() === text);
const open: State = { lock: null, heldCount: 0 };
const locked = (extra: Partial<NonNullable<State["lock"]>> = {}): State => ({
  lock: {
    lockedBy: { id: "u-me", name: "Dana" },
    reason: "Release freeze",
    expiresAt: "2026-11-30T10:00:00Z",
    ...extra,
  },
  heldCount: 0,
});

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DeployLockControl", () => {
  it("unlocked and may lock: Open badge and Lock button", async () => {
    await mount({ state: open });
    expect(container.textContent).toContain(l.open);
    expect(named(l.lock)).toBeTruthy();
  });

  it("unlocked with held builds: badge includes the count", async () => {
    await mount({ state: { lock: null, heldCount: 3 } });
    expect(container.textContent).toContain("Open · 3 held");
  });

  it("unlocked, cannot lock, nothing held: renders nothing", async () => {
    await mount({ role: "viewer", state: open });
    expect(container.textContent).toBe("");
  });

  it("unlocked, cannot lock, builds held: badge without Lock", async () => {
    await mount({ role: "viewer", state: { lock: null, heldCount: 2 } });
    expect(container.textContent).toContain("Open · 2 held");
    expect(named(l.lock)).toBeUndefined();
  });

  it("locked: Locked badge whose popover shows holder, reason and expiry", async () => {
    await mount({
      role: "viewer",
      state: locked({ lockedBy: { id: "x", name: "Dana" } }),
    });
    const badge = named(l.lockedState);
    expect(badge).toBeTruthy();
    await act(async () => badge?.click());
    const text = document.body.textContent ?? "";
    expect(text).toContain("Dana");
    expect(text).toContain("Release freeze");
    expect(text).toContain("Nov 30, 2026");
  });

  it("locked with held builds: badge includes the count", async () => {
    await mount({ role: "viewer", state: { ...locked(), heldCount: 4 } });
    expect(container.textContent).toContain("Locked · 4 held");
  });

  it("locked and may unlock: Unlock button", async () => {
    await mount({ state: locked() });
    expect(named(l.unlock)).toBeTruthy();
  });

  it("locked and Edit allowed: the menu has Edit", async () => {
    await mount({ state: locked() });
    const more = container.querySelector(
      `button[aria-label="${l.moreActions}"]`
    );
    await act(async () => (more as HTMLElement).click());
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) =>
      i.textContent?.trim()
    );
    expect(items).toContain(l.edit);
    expect(items).not.toContain(l.forceUnlock);
  });

  it("mayForce only: menu has Force unlock and there is no Unlock", async () => {
    await mount({
      role: "viewer",
      orgRole: "admin",
      state: locked({ lockedBy: { id: "someone", name: "Dana" } }),
    });
    expect(named(l.unlock)).toBeUndefined();
    const more = container.querySelector(
      `button[aria-label="${l.moreActions}"]`
    );
    await act(async () => (more as HTMLElement).click());
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) =>
      i.textContent?.trim()
    );
    expect(items).toContain(l.forceUnlock);
  });

  it("locked with no actions: badge only", async () => {
    await mount({
      role: "viewer",
      state: locked({ lockedBy: { id: "someone", name: "Dana" } }),
    });
    expect(buttons()).toHaveLength(1);
    expect(
      container.querySelector(`button[aria-label="${l.moreActions}"]`)
    ).toBeNull();
  });
});
