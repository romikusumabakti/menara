// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/web/api/knowledge", () => ({
  searchKnowledge: vi.fn(async () => []),
}));

import {
  KnowledgeSearchProvider,
  KnowledgeSearchTrigger,
} from "@/components/knowledge-search";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(withTrigger = true) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <KnowledgeSearchProvider>
          {withTrigger && <KnowledgeSearchTrigger variant="sidebar" />}
          {withTrigger && <KnowledgeSearchTrigger variant="hero" />}
          <input data-testid="field" />
        </KnowledgeSearchProvider>
      </IntlProvider>
    );
  });
}

const dialogs = () => document.querySelectorAll('[role="dialog"]');
const press = (target: Element, key: string) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  });

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("knowledge search", () => {
  it("opens exactly one dialog on / with two triggers mounted", async () => {
    await render();
    expect(dialogs()).toHaveLength(0);
    await press(document.body, "/");
    expect(dialogs()).toHaveLength(1);
  });

  it("does not react to / when no search trigger is rendered", async () => {
    await render(false);
    await press(document.body, "/");
    expect(dialogs()).toHaveLength(0);
  });

  it.each(["svg", "kbd"])(
    "opens from the %s beside the label, not only the label",
    async (selector) => {
      await render();
      const hit = container.querySelector(
        `[data-slot="input-group-addon"] ${selector}`
      );
      expect(hit).not.toBeNull();
      await act(async () => {
        hit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(dialogs()).toHaveLength(1);
    }
  );

  it("ignores / while typing in an input", async () => {
    await render();
    await press(container.querySelector("input") as Element, "/");
    expect(dialogs()).toHaveLength(0);
  });

  it.each(["sidebar", "hero"])(
    "opens the same dialog from the %s trigger",
    async (variant) => {
      await render();
      const triggers = [...container.querySelectorAll("button")].filter((b) =>
        b.textContent?.includes(messages.knowledge.searchPlaceholder)
      );
      expect(triggers).toHaveLength(2);
      await act(async () => {
        triggers[variant === "sidebar" ? 0 : 1]?.click();
      });
      expect(dialogs()).toHaveLength(1);
    }
  );
});
