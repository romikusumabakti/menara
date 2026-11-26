// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantPending } from "../web/routes/$locale/_app/-components/assistant-pending";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("assistant pending skeleton", () => {
  it("uses the workspace shell: sidebar rows beside a main skeleton", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<AssistantPending />));
    const shell = container.firstElementChild as HTMLElement;
    expect(shell.className).toContain("h-[calc(100svh-3.5rem)]");
    expect(shell.querySelector("aside")).not.toBeNull();
    expect(
      shell.querySelectorAll('aside [data-slot="sidebar-skeleton-row"]').length
    ).toBeGreaterThanOrEqual(5);
    expect(
      shell.querySelector('main [data-slot="main-skeleton"]')
    ).not.toBeNull();
  });
});
