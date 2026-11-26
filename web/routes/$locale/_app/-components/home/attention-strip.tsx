import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { Card } from "@/components/ui/card";
import {
  getAttentionGroupsQuery,
  getInstanceBackupAttentionQuery,
} from "@/web/api/home";
import { AttentionList } from "./attention-list";
import { SectionError } from "./section-error";

/**
 * Failures that need someone, above everything else: the unacknowledged failed
 * runs and (for those who manage the instance) the stale or failed instance
 * backup. Owns its queries; renders nothing while they load and when there is
 * nothing to attend to, so it takes no space unless it matters. A failed
 * failures query is a one-line error, not a silently missing strip.
 */
export function AttentionStrip() {
  const t = useTranslations("homePage");
  const attention = useQuery(getAttentionGroupsQuery());
  // Not waited for: a failure or a slow answer only leaves the item out.
  const instanceBackup =
    useQuery(getInstanceBackupAttentionQuery()).data ?? null;

  if (attention.data === undefined) {
    return attention.isError ? (
      <Card className="py-0">
        <SectionError compact />
      </Card>
    ) : null;
  }
  if (attention.data.length === 0 && !instanceBackup) return null;
  return (
    <Card
      role="region"
      aria-label={t("attention.title")}
      className="py-0 gap-0 overflow-hidden shrink-0"
    >
      <AttentionList groups={attention.data} instanceBackup={instanceBackup} />
    </Card>
  );
}
