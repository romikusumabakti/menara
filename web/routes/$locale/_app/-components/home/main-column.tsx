import { useQuery } from "@tanstack/react-query";
import { CircleDot } from "lucide-react";
import { useTranslations } from "use-intl";
import { Link } from "@/i18n/navigation";
import { listMyOpenIssuesQuery, type MyIssue } from "@/web/api/home";
import { AskAssistantCard } from "./ask-assistant-card";
import { CompactSection, HomeSection } from "./home-section";
import { MyIssuesList } from "./my-issues-list";
import { SectionError } from "./section-error";
import { MainColumnSkeleton } from "./skeletons";

// The page does not wait for this query (the loader only starts it): the
// skeleton shows until it has settled. A failed query is a failed section, not
// a failed page. Failures live in the AttentionStrip above the grid.
export function MainColumn() {
  const issues = useQuery(listMyOpenIssuesQuery());
  // The ask card leads: it hides itself unless the assistant is on, and does
  // not wait for the issues.
  if (issues.data === undefined && !issues.isError) {
    return (
      <>
        <AskAssistantCard />
        <MainColumnSkeleton />
      </>
    );
  }

  return (
    <>
      <AskAssistantCard />
      <MyIssuesSection data={issues.data} />
    </>
  );
}

function MyIssuesSection({
  data,
}: {
  data: { items: MyIssue[]; total: number } | undefined;
}) {
  const t = useTranslations("homePage");
  if (data && data.total === 0) {
    return (
      <CompactSection
        icon={CircleDot}
        title={t("issues.title")}
        text={t("issues.empty")}
      />
    );
  }
  return (
    <HomeSection
      icon={CircleDot}
      title={t("issues.title")}
      action={
        data ? (
          <Link
            href="/issues?mine=1"
            className="text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            {t("issues.viewAll", { count: data.total })}
          </Link>
        ) : null
      }
    >
      {data ? <MyIssuesList items={data.items} /> : <SectionError />}
    </HomeSection>
  );
}
