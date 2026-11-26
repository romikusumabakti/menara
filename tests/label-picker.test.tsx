// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LabelPicker } from "@/components/label-ui";
import messages from "../messages/en.json";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const LABELS = Array.from({ length: 200 }, (_, i) => ({
  id: `id-${String(i + 1).padStart(3, "0")}`,
  name: `label-${String(i + 1).padStart(3, "0")}`,
  color: "#3366ff",
}));

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

const input = () =>
  document.querySelector<HTMLInputElement>('input[role="combobox"]');
const options = () => [
  ...document.querySelectorAll<HTMLElement>('[role="option"]'),
];

async function render(props: Record<string, unknown> = {}) {
  const all = { allLabels: LABELS, selected: [], onChange: vi.fn(), ...props };
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <LabelPicker {...(all as Parameters<typeof LabelPicker>[0])} />
      </IntlProvider>
    )
  );
  await act(async () => {
    container.querySelector<HTMLElement>("button")?.click();
  });
  await settle();
  return all.onChange as ReturnType<typeof vi.fn>;
}

async function type(text: string) {
  const el = input() as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(el, text);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      })
    );
  });
  await settle();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("LabelPicker", () => {
  it("opens with a search input and a scrollable, height-capped list", async () => {
    await render();
    expect(input()).not.toBeNull();
    const list = document.querySelector<HTMLElement>(
      '[data-slot="combobox-list"]'
    );
    expect(list?.className).toContain("overflow-y-auto");
    expect(list?.className).toMatch(/max-h-/);
  });

  it("filters by typed text", async () => {
    await render();
    await type("label-15");
    expect(options().map((o) => o.textContent)).toEqual(
      Array.from({ length: 10 }, (_, i) => `label-15${i}`)
    );
  });

  it("adds and removes a label id on click", async () => {
    const onChange = await render();
    await type("label-150");
    await act(async () => options()[0]?.click());
    expect(onChange).toHaveBeenLastCalledWith(["id-150"]);

    onChange.mockClear();
    await act(async () => root.unmount());
    root = createRoot(container);
    const again = await render({ selected: ["id-150"] });
    await type("label-150");
    await act(async () => options()[0]?.click());
    expect(again).toHaveBeenLastCalledWith([]);
  });
});
