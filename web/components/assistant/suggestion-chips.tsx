import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import type { Suggestion } from "@/lib/assistant/suggestions";
import { assistantSuggestionsQuery } from "@/web/api/assistant";
import { ASSISTANT_COMPOSER_ID } from "./assistant-shortcut";
import {
  composerDrafts,
  type DraftKey,
  useComposerDraft,
  useDraftUser,
} from "./composer-drafts";

const RUN_KINDS = [
  "backup",
  "restore",
  "mock_time",
  "test",
  "deploy",
  "provision",
  "teardown",
  "release",
] as const;

function contextOf(s: Suggestion) {
  if (!s.context) return null;
  return s.context.kind === "environment"
    ? ({ kind: "environment", environmentId: s.context.id } as const)
    : ({ kind: "project", projectId: s.context.id } as const);
}

/**
 * Starter questions under the composer, from the caller's own activity. A
 * click fills the draft (never sends), sets the context the question is
 * about and focuses the box. Shown only while the draft is empty.
 */
export function SuggestionChips({
  draftKey,
  onPick,
}: {
  draftKey: DraftKey;
  onPick?: () => void;
}) {
  const tSuggestions = useTranslations("assistant.suggestions");
  const items = useQuery(assistantSuggestionsQuery()).data?.items;
  const userId = useDraftUser();
  const [draft] = useComposerDraft(userId, draftKey);

  if (!items || items.length === 0 || draft.text !== "") return null;

  const wording = (s: Suggestion): string => {
    switch (s.kind) {
      case "failedRun": {
        const raw = String(s.params.runKind);
        const runKind = (RUN_KINDS as readonly string[]).includes(raw)
          ? raw
          : "other";
        return tSuggestions("failedRun", {
          runKind: tSuggestions(`runKind.${runKind}`),
          environment: String(s.params.environment),
        });
      }
      case "myIssues":
        return tSuggestions("myIssues", s.params);
      case "environment":
        return tSuggestions("environment", s.params);
      case "general":
        return tSuggestions(`general.${String(s.params.question)}`);
    }
  };

  return (
    <div className="flex flex-wrap justify-center gap-2" data-suggestions>
      {items.map((s, i) => {
        const text = wording(s);
        return (
          <Button
            // Order is the server's; a kind can repeat (general).
            key={i}
            data-suggestion
            variant="outline"
            size="sm"
            className="h-auto max-w-full gap-1.5 whitespace-normal rounded-full py-1 text-start font-normal"
            onClick={() => {
              const context = contextOf(s);
              composerDrafts.update(draftKey, (d) => ({
                ...d,
                text,
                ...(context ? { context } : {}),
              }));
              document.getElementById(ASSISTANT_COMPOSER_ID)?.focus();
              onPick?.();
            }}
          >
            {s.kind === "failedRun" && (
              <span
                data-failed-dot
                aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-destructive"
              />
            )}
            {text}
          </Button>
        );
      })}
    </div>
  );
}
