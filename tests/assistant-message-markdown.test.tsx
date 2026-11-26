// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import enMessages from "../messages/en.json";

const messages = applyBranding(enMessages, {
  appName: "Menara",
  companyName: null,
  allowedEmailDomain: "example.com",
});

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/en/assistant",
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
vi.mock("@/web/api/project-catalog", () => ({
  listProjectsQuery: () => ({
    queryKey: ["project-catalog", "listProjects", []],
    queryFn: () => new Promise(() => {}),
  }),
}));

import {
  MessageView,
  type ShownMessage,
} from "@/web/components/assistant/message-view";

const message = (
  role: "user" | "assistant",
  content: string
): ShownMessage => ({
  id: "m1",
  role,
  content,
  status: "done",
  errorCode: null,
  sources: null,
  attachmentIds: [],
  files: [],
  createdAt: "2026-11-16T01:00:00Z",
  toolCalls: [],
  context: null,
  parts: null,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(m: ShownMessage) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <MessageView message={m} />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

describe("MessageView markdown", () => {
  it("renders a question as markdown and keeps its line breaks", async () => {
    await render(message("user", "**bold**\nline two"));
    const bubble = container.querySelector("[data-markdown]")?.parentElement;
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelectorAll("br")).toHaveLength(1);
    expect(bubble?.className).not.toContain("whitespace-pre-wrap");
  });

  it("renders an answer list with outside markers", async () => {
    await render(message("assistant", "- one\n- two"));
    expect(container.querySelector("ul.list-outside")).not.toBeNull();
  });
});
