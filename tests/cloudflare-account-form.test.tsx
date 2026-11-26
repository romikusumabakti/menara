// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: () => {} }));

const { CloudflareAccountForm } = await import(
  "@/components/cloudflare-account-form"
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("CloudflareAccountForm", () => {
  it("has no Name field", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <IntlProvider locale="en" messages={messages}>
            <CloudflareAccountForm account={null} />
          </IntlProvider>
        </QueryClientProvider>
      );
    });
    expect(container.querySelector("input[name='name']")).toBeNull();
    expect(container.textContent).not.toContain("Name");
    expect(container.querySelector("input[name='accountId']")).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
