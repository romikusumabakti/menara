import {
  type AttentionGroup,
  getAttentionGroups,
  listMyOpenIssues,
  listRecentEnvironments,
  type MyIssue,
  type RecentEnvironment,
} from "@/lib/home/queries";
import { qualifiedEnvName } from "@/lib/nav-path";

// Starter questions for the assistant composer, built from the caller's own
// activity. No AI call; the wording lives in the client's i18n catalog, so
// `params` carries raw values only.

export type Suggestion = {
  kind: "failedRun" | "myIssues" | "environment" | "general";
  params: Record<string, string | number>;
  context: { kind: "environment" | "project"; id: string } | null;
};

export const MAX_SUGGESTIONS = 4;
export const GENERAL_QUESTIONS = [
  "changedToday",
  "failedDeploysThisWeek",
] as const;

export function buildSuggestions(input: {
  attention: AttentionGroup[];
  myIssues: { items: MyIssue[]; total: number };
  recentEnvironments: RecentEnvironment[];
}): Suggestion[] {
  const out: Suggestion[] = [];

  const failed = input.attention.reduce<AttentionGroup | undefined>(
    (best, g) =>
      !best || g.latest.runAt.getTime() > best.latest.runAt.getTime()
        ? g
        : best,
    undefined
  );
  if (failed) {
    out.push({
      kind: "failedRun",
      params: {
        runKind: failed.latest.kind ?? "other",
        // Already "Project · Env" (the home query qualifies it).
        environment: failed.environmentName,
      },
      context: { kind: "environment", id: failed.environmentId },
    });
  }

  const firstIssue = input.myIssues.items[0];
  if (firstIssue) {
    out.push({
      kind: "myIssues",
      params: {
        count: input.myIssues.total,
        firstKey: `${firstIssue.projectKey}-${firstIssue.number}`,
      },
      context: null,
    });
  }

  const recent = input.recentEnvironments.find(
    (e) => e.id !== failed?.environmentId
  );
  if (recent) {
    out.push({
      kind: "environment",
      params: {
        environment: qualifiedEnvName(recent.name, recent.projectName),
      },
      context: { kind: "environment", id: recent.id },
    });
  }

  for (const question of GENERAL_QUESTIONS) {
    out.push({ kind: "general", params: { question }, context: null });
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

/** The caller's suggestions; each query scopes itself to the session user. */
export async function getSuggestions(): Promise<Suggestion[]> {
  const [attention, myIssues, recentEnvironments] = await Promise.all([
    getAttentionGroups(),
    listMyOpenIssues(),
    listRecentEnvironments(),
  ]);
  return buildSuggestions({ attention, myIssues, recentEnvironments });
}
