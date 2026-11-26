// @vitest-environment happy-dom
import GithubSlugger from "github-slugger";
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

vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({
    href,
    children,
    ...rest
  }: { href: string; children?: React.ReactNode } & Record<
    string,
    unknown
  >) => (
    <a href={href} data-app-link="" {...rest}>
      {children}
    </a>
  ),
}));

import { Markdown } from "@/components/markdown";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function render(props: React.ComponentProps<typeof Markdown>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Markdown {...props} />
      </IntlProvider>
    );
  });
  return container;
}

describe("Markdown", () => {
  it("renders a language-less fence as a block", async () => {
    const el = await render({
      content: "```\nGET /a\nGET /b\n```",
      mode: "static",
    });
    const pres = el.querySelectorAll("pre");
    expect(pres).toHaveLength(1);
    const code = el.querySelector("pre code");
    expect(code).not.toBeNull();
    expect(code?.className).not.toContain("bg-muted");
    expect(code?.className).not.toContain("px-1.5");
    expect(el.textContent).toContain("GET /b");
  });

  it("styles inline code", async () => {
    const el = await render({ content: "run `bun test` now", mode: "static" });
    expect(el.querySelector("pre")).toBeNull();
    expect(el.querySelector("code")?.className).toContain("bg-muted");
  });

  it("lists render outside markers", async () => {
    const el = await render({ content: "- a\n- b", mode: "static" });
    const ul = el.querySelector("ul");
    expect(ul?.className).toContain("list-outside");
    expect(ul?.className).not.toContain("list-inside");
    const ol = (
      await rerender({ content: "1. a\n2. b", mode: "static" })
    ).querySelector("ol");
    expect(ol?.className).toContain("list-outside");
    expect(ol?.className).not.toContain("list-inside");
  });

  it("task lists drop the marker", async () => {
    const el = await render({
      content: "- [x] done\n- [ ] open",
      mode: "static",
    });
    expect(el.querySelector("ul")?.className).toContain("list-none");
    expect(el.querySelectorAll("input[type=checkbox]")).toHaveLength(2);
  });

  it("paragraphs are spaced", async () => {
    const content =
      "para one.\n\npara two.\n\n**Label:** text\n\n**Heading** (x):\n- item\n- item";
    for (const mode of ["static", "streaming"] as const) {
      const el = await rerender({ content, mode });
      const ps = [...el.querySelectorAll("p")];
      expect(ps.map((p) => p.textContent)).toEqual([
        "para one.",
        "para two.",
        "Label: text",
        "Heading (x):",
      ]);
      for (const p of ps) {
        expect(p.className).toContain("my-3");
        // Streaming wraps every block in its own `display: contents` div, so
        // a `first:`/`last:` margin reset would hit every paragraph.
        expect(p.className).not.toMatch(/(^|\s)(first|last):/);
      }
      const rootClass = el.querySelector("[data-markdown]")?.className ?? "";
      expect(rootClass).toContain("[&>:first-child>:first-child]:mt-0");
      expect(rootClass).not.toContain("space-y-4");
      expect(el.querySelector("strong")?.textContent).toBe("Label:");
      expect(el.querySelectorAll("li")).toHaveLength(2);
    }
  });

  it("blocks non-web links for every mode", async () => {
    for (const mode of ["static", "streaming"] as const) {
      const el = await rerender({
        content: "[x](javascript:alert(1))",
        mode,
      });
      expect(el.querySelector("a")).toBeNull();
      expect(el.textContent).toContain("x");
    }
  });

  it("renders people links without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const el = await render({
      content: `Ask [Ana Example](/people/${ID}).`,
      mode: "static",
    });
    const a = el.querySelector("a");
    expect(a?.getAttribute("href")).toMatch(new RegExp(`/people/${ID}$`));
    expect(a?.textContent).toBe("Ana Example");
    expect(a?.getAttribute("target")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("app links stay in the tab", async () => {
    const el = await render({
      content: "[ACME](/ACME) and [site](https://example.com)",
      mode: "static",
    });
    const links = [...el.querySelectorAll("a")];
    expect(links).toHaveLength(2);
    const [app, ext] = links as [HTMLAnchorElement, HTMLAnchorElement];
    expect(app.getAttribute("href")).toBe("/ACME");
    expect(app.hasAttribute("data-app-link")).toBe(true);
    expect(app.getAttribute("target")).toBeNull();
    expect(ext.getAttribute("href")).toBe("https://example.com/");
    expect(ext.getAttribute("target")).toBe("_blank");
    expect(ext.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("images only with allowImages", async () => {
    const content = "![screenshot](/api/knowledge/asset/1)";
    let el = await render({ content, mode: "static" });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("screenshot");
    el = await rerender({ content, mode: "static", allowImages: true });
    const img = el.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("src")).toContain("/api/knowledge/asset/1");
  });

  it("line breaks only when asked", async () => {
    let el = await render({ content: "a\nb", mode: "static" });
    expect(el.querySelectorAll("br")).toHaveLength(0);
    el = await rerender({ content: "a\nb", mode: "static", lineBreaks: true });
    expect(el.querySelectorAll("br")).toHaveLength(1);
  });

  it("heading ids match github-slugger", async () => {
    const el = await render({
      content: "# Setup\n\n# Setup\n\n## Instalasi Ünïcode",
      mode: "static",
      headingIds: true,
    });
    const slugger = new GithubSlugger();
    const expected = ["Setup", "Setup", "Instalasi Ünïcode"].map((t) =>
      slugger.slug(t)
    );
    expect(
      [...el.querySelectorAll("h1, h2")].map((h) => h.getAttribute("id"))
    ).toEqual(expected);
    const plain = await rerender({ content: "# Setup", mode: "static" });
    expect(plain.querySelector("h1")?.hasAttribute("id")).toBe(false);
  });

  it("in-page anchors reach the heading ids", async () => {
    const el = await render({
      content: "[see](#setup)\n\n# Setup",
      mode: "static",
      headingIds: true,
    });
    const a = el.querySelector("a");
    expect(a?.getAttribute("href")).toBe("#setup");
    expect(a?.hasAttribute("data-app-link")).toBe(false);
    expect(a?.getAttribute("target")).toBeNull();
    expect(el.querySelector("h1")?.id).toBe("setup");
  });

  it("raw HTML is dropped", async () => {
    const el = await render({
      content: "<b>x</b><script>y</script>",
      mode: "static",
    });
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
  });

  it("gives each block its own direction", async () => {
    await render({ content: "", mode: "static" });
    for (const mode of ["static", "streaming"] as const) {
      const el = await rerender({ content: "hello\n\nمرحبا", mode });
      expect(el.querySelector("[data-markdown]")).not.toBeNull();
      // dir="auto": each block takes the direction of its own text.
      expect(el.querySelector('[dir="ltr"]')?.textContent).toBe("hello");
      expect(el.querySelector('[dir="rtl"]')?.textContent).toBe("مرحبا");
    }
  });
});

/** Re-render into a fresh container (each call unmounts the previous one). */
async function rerender(props: React.ComponentProps<typeof Markdown>) {
  act(() => root.unmount());
  container.remove();
  return render(props);
}
