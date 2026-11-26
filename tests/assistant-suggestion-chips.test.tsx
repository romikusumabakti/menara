// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locales } from "@/i18n/locales";
import { GENERAL_QUESTIONS } from "@/lib/assistant/suggestions";
import { ASSISTANT_COMPOSER_ID } from "@/web/components/assistant/assistant-shortcut";
import {
  composerDrafts,
  NEW_CHAT,
} from "@/web/components/assistant/composer-drafts";
import {
  RUN_KINDS,
  SuggestionChips,
} from "@/web/components/assistant/suggestion-chips";
import { ME_QUERY_KEY } from "@/web/query-client";
import enMessages from "../messages/en.json";

const api = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/web/api/assistant", () => ({
  assistantSuggestionsQuery: () => ({
    queryKey: ["assistant", "suggestions"],
    queryFn: () => new Promise(() => {}),
  }),
  sendMessage: api.send,
  createConversation: api.send,
  uploadFile: vi.fn(),
  deleteUpload: vi.fn(),
}));

const ITEMS = [
  {
    kind: "failedRun",
    params: { runKind: "deploy", environment: "ACME · staging" },
    context: { kind: "environment", id: "env-1" },
  },
  {
    kind: "myIssues",
    params: { count: 3, firstKey: "ACME-12" },
    context: null,
  },
  {
    kind: "environment",
    params: { environment: "BETA · production" },
    context: { kind: "project", id: "proj-1" },
  },
  { kind: "general", params: { question: "changedToday" }, context: null },
  {
    kind: "general",
    params: { question: "failedDeploysThisWeek" },
    context: null,
  },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(ME_QUERY_KEY, {
    user: { id: "user-1" },
    orgRole: "member",
    timeZone: "UTC",
  });
  composerDrafts.resetForTests();
  api.send.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.getElementById(ASSISTANT_COMPOSER_ID)?.remove();
});

async function render(items: object[] | null = ITEMS) {
  if (items) queryClient.setQueryData(["assistant", "suggestions"], { items });
  container = document.createElement("div");
  document.body.append(container);
  const input = document.createElement("textarea");
  input.id = ASSISTANT_COMPOSER_ID;
  document.body.append(input);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={enMessages} timeZone="UTC">
          <SuggestionChips draftKey={NEW_CHAT} />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  return input;
}

const chips = () => [
  ...container.querySelectorAll<HTMLButtonElement>("[data-suggestion]"),
];

describe("SuggestionChips", () => {
  it("words each suggestion from its params", async () => {
    await render();
    expect(chips().map((c) => c.textContent)).toEqual([
      "Why did the deploy on ACME · staging fail?",
      "Summarize my 3 open issues, starting with ACME-12",
      "What is running on BETA · production right now?",
      "What changed today?",
      "Which deploys failed this week?",
    ]);
  });

  it("marks only the failed-run chip with the destructive dot", async () => {
    await render();
    const dots = chips().map((c) => !!c.querySelector("[data-failed-dot]"));
    expect(dots).toEqual([true, false, false, false, false]);
  });

  it("is a named group of chips", async () => {
    await render();
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute("aria-label")).toBe(
      enMessages.assistant.suggestions.groupLabel
    );
    expect(group?.querySelectorAll("[data-suggestion]")).toHaveLength(5);
  });

  it("renders nothing while loading", async () => {
    await render(null);
    expect(container.textContent).toBe("");
  });

  it("renders nothing when empty", async () => {
    await render([]);
    expect(container.textContent).toBe("");
  });

  it("a click fills the draft, sets the context and focuses the composer without sending", async () => {
    const input = await render();
    await act(async () => chips()[0]?.click());
    const draft = composerDrafts.get(NEW_CHAT);
    expect(draft.text).toBe("Why did the deploy on ACME · staging fail?");
    expect(draft.context).toEqual({
      kind: "environment",
      environmentId: "env-1",
    });
    expect(document.activeElement).toBe(input);
    expect(api.send).not.toHaveBeenCalled();
  });

  it("maps a project context and leaves the context alone when there is none", async () => {
    await render();
    await act(async () => chips()[2]?.click());
    expect(composerDrafts.get(NEW_CHAT).context).toEqual({
      kind: "project",
      projectId: "proj-1",
    });
    composerDrafts.update(NEW_CHAT, (d) => ({ ...d, text: "" }));
    await act(async () => chips()[3]?.click());
    expect(composerDrafts.get(NEW_CHAT).context).toEqual({
      kind: "project",
      projectId: "proj-1",
    });
  });

  it("hides once the draft has text, and never overwrites it", async () => {
    await render();
    await act(async () => {
      composerDrafts.update(NEW_CHAT, (d) => ({ ...d, text: "typed" }));
    });
    expect(chips()).toHaveLength(0);
    expect(composerDrafts.get(NEW_CHAT).text).toBe("typed");
  });
});

describe("suggestion messages", () => {
  it("has wording for every question and run kind the code can emit", () => {
    const s = enMessages.assistant.suggestions as unknown as {
      general: Record<string, string>;
      runKind: Record<string, string>;
    };
    for (const q of GENERAL_QUESTIONS) expect(s.general[q], q).toBeTruthy();
    for (const k of [...RUN_KINDS, "other"]) {
      expect(s.runKind[k], k).toBeTruthy();
    }
  });

  const keys = (o: unknown, p = ""): string[] =>
    typeof o === "object" && o !== null
      ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}${k}.`))
      : [p.slice(0, -1)];

  it("every locale carries every template, and the static examples are gone", async () => {
    const want = keys(enMessages.assistant.suggestions);
    expect(want.length).toBeGreaterThan(10);
    for (const locale of locales) {
      const m = (await import(`../messages/${locale}.json`)).default;
      expect(keys(m.assistant.suggestions).sort(), locale).toEqual(want.sort());
      expect(m.homePage.askExamples, locale).toBeUndefined();
    }
  });
});
