// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import type { McpScope } from "@/lib/mcp/scopes";
import enMessages from "../messages/en.json";

const auth = vi.hoisted(() => ({
  consent: vi.fn(async (_input: { accept: boolean; scope?: string }) => ({
    data: { redirect: true, url: "http://127.0.0.1:8976/callback?code=x" },
    error: null,
  })),
  signOut: vi.fn(async () => ({ data: { success: true }, error: null })),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { oauth2: { consent: auth.consent }, signOut: auth.signOut },
}));

import {
  ConsentCard,
  type ConsentInfo,
  ConsentTitle,
} from "@/web/routes/$locale/-components/oauth/consent-card";

let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  auth.consent.mockClear();
  auth.signOut.mockClear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  document.body.innerHTML = "";
});

function info(
  scopes: McpScope[],
  overrides: Partial<ConsentInfo> = {}
): ConsentInfo {
  return {
    client: {
      name: "Acme Agent",
      host: "agent.example.com",
      logoUrl: null,
    },
    redirectHost: "127.0.0.1",
    scopes,
    offlineAccess: true,
    account: { name: "Ada Admin", email: "ada@example.com" },
    ...overrides,
  };
}

async function render(consentInfo: ConsentInfo) {
  const messages = applyBranding(enMessages, {
    appName: "Acme Ops",
    companyName: null,
    allowedEmailDomain: "example.com",
  });
  const el = document.createElement("div");
  document.body.append(el);
  container = el;
  const r = createRoot(el);
  root = r;
  await act(async () =>
    r.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <h1>
          <ConsentTitle info={consentInfo} />
        </h1>
        <ConsentCard info={consentInfo} oauthQuery="client_id=x&sig=y" />
      </IntlProvider>
    )
  );
}

function checkbox(scope: string) {
  return document.querySelector<HTMLElement>(
    `[role="checkbox"][data-scope="${scope}"]`
  );
}

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function button(name: string) {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name
  );
}

describe("ConsentCard", () => {
  it("always includes read and cannot untick it", async () => {
    await render(info(["read", "issues:write"]));
    const row = document.querySelector('[data-scope-row="read"]');
    expect(row?.textContent).toContain(
      "See projects, issues, environments, deploys, servers, code and knowledge you can see"
    );
    expect(row?.textContent).toContain("Always included");
    // No checkbox to untick: read is part of every grant.
    expect(checkbox("read")).toBeNull();
    await click(button("Allow"));
    expect(auth.consent).toHaveBeenCalledWith({
      accept: true,
      scope: "offline_access read issues:write",
    });
  });

  it("sends only ticked scopes plus read on Allow", async () => {
    await render(info(["read", "issues:write", "deploys:write"]));
    expect(checkbox("issues:write")?.getAttribute("aria-checked")).toBe("true");
    expect(checkbox("deploys:write")?.getAttribute("aria-checked")).toBe(
      "true"
    );
    await click(checkbox("deploys:write"));
    expect(checkbox("deploys:write")?.getAttribute("aria-checked")).toBe(
      "false"
    );
    await click(button("Allow"));
    expect(auth.consent).toHaveBeenCalledTimes(1);
    expect(auth.consent).toHaveBeenCalledWith({
      accept: true,
      scope: "offline_access read issues:write",
    });
  });

  it("leaves offline_access out when it was not requested", async () => {
    await render(info(["read"], { offlineAccess: false }));
    await click(button("Allow"));
    expect(auth.consent).toHaveBeenCalledWith({ accept: true, scope: "read" });
  });

  it("shows the database warning only when database:read is requested", async () => {
    const warning = "Query results are sent to the AI model this app uses.";
    await render(info(["read", "issues:write"]));
    expect(container?.textContent).not.toContain(warning);
    expect(document.querySelector('[data-scope-row="database:read"]')).toBe(
      null
    );
    act(() => root?.unmount());
    root = undefined;
    container?.remove();

    await render(info(["read", "database:read"]));
    const row = document.querySelector('[data-scope-row="database:read"]');
    expect(row?.textContent).toContain(
      "Query databases where Assistant database access is on"
    );
    expect(row?.textContent).toContain(warning);
  });

  it("shows the client_id host, not only the self-asserted name", async () => {
    await render(info(["read"]));
    expect(document.querySelector("h1")?.textContent).toBe(
      "Allow Acme Agent to use your Acme Ops account?"
    );
    expect(container?.textContent).toContain("agent.example.com");
    // Where the code goes, and who is signed in.
    expect(container?.textContent).toContain("127.0.0.1");
    expect(container?.textContent).toContain("ada@example.com");
    expect(container?.textContent).toContain(
      "You can revoke access any time in Account › Connected apps."
    );
    // No hotlinked logo.
    expect(container?.querySelector("img")).toBeNull();
  });

  it("names the host when the client's name is empty", async () => {
    for (const name of ["", "   "]) {
      await render(
        info(["read"], {
          client: { name, host: "agent.example.com", logoUrl: null },
        })
      );
      expect(document.querySelector("h1")?.textContent).toBe(
        "Allow agent.example.com to use your Acme Ops account?"
      );
      act(() => root?.unmount());
      container?.remove();
      root = container = undefined;
    }
  });

  it("sends accept:false on Deny", async () => {
    await render(info(["read", "issues:write"]));
    await click(button("Deny"));
    expect(auth.consent).toHaveBeenCalledWith({ accept: false });
  });

  it("signs out and keeps the query on Switch account", async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, assign },
    });
    try {
      await render(info(["read"]));
      const link = [...document.querySelectorAll("button, a")].find((el) =>
        el.textContent?.includes("Switch account")
      );
      await click(link);
      expect(auth.signOut).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith("/en/sign-in?client_id=x&sig=y");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: original,
      });
    }
  });
});
