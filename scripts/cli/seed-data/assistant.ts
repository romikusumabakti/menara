// Fictional Assistant conversations for the demo-admin account, so a demo
// instance (and the README screenshots) shows a finished chat without asking
// a real model. Newest first is how the sidebar lists them.
import type { PersonRef } from "./issues";

export interface DemoTurn {
  question: string;
  answer: string;
}

export interface DemoConversation {
  owner: PersonRef;
  title: string;
  /** Project key the questions are pinned to; absent for an automatic one. */
  project?: string;
  daysAgo: number;
  turns: DemoTurn[];
}

export const DEMO_CONVERSATIONS: readonly DemoConversation[] = [
  {
    owner: "demo-admin",
    title: "Why does the member import reject empty rows?",
    project: "DEMO",
    daysAgo: 0,
    turns: [
      {
        question:
          "QA says the member import fails when the spreadsheet ends with an empty row. Why, and what would a fix look like?",
        answer: [
          "The import validates every row it reads, and an empty row is still a row: it has no member number, so validation rejects it and the whole file fails.",
          "",
          "What happens on QA (commit `4f2a9c1`):",
          "",
          "1. `MemberImportReader` turns each spreadsheet row into a `MemberRow`, including rows whose cells are all blank.",
          "2. `MemberRowValidator.validate` requires `memberNumber`, so a blank row fails with `IMPORT_MEMBER_NUMBER_REQUIRED`.",
          "3. `MemberImportService` stops at the first failed row and reports the file as rejected.",
          "",
          "A fix that keeps the rule for real rows is to skip rows whose cells are all blank before validating them:",
          "",
          "```java",
          "rows.stream()",
          "    .filter(row -> !row.isBlank())",
          "    .map(validator::validate)",
          "```",
          "",
          "The open issue **Member import rejects empty rows** tracks this. Dev runs the same commit, so it reproduces there too.",
        ].join("\n"),
      },
    ],
  },
  {
    owner: "demo-admin",
    title: "Which build is running on Demo Portal QA?",
    project: "DEMOPORTAL",
    daysAgo: 1,
    turns: [
      {
        question:
          "Which build is running on Demo Portal QA, and what changed since Dev?",
        answer:
          "QA runs build `2026.11.3` (commit `9b1e07d`), deployed yesterday. Dev is two commits ahead: the contribution summary report and a fix for the download button on the member card.",
      },
    ],
  },
  {
    owner: "demo-admin",
    title: "Summarise this week's open issues",
    daysAgo: 3,
    turns: [
      {
        question: "Summarise the open issues across my projects this week.",
        answer:
          "Five issues are open: two bugs on Demo Membership (member import, NIK validation), one on Demo Portal (member card download), and two tasks (the QA release checklist and retiring the old export endpoint).",
      },
    ],
  },
];
