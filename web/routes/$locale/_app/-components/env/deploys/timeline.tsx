import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  History,
  Loader2,
  Lock,
  ShieldCheck,
  SkipForward,
} from "lucide-react";
import * as React from "react";
import { useNow, useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DeployTargetState } from "@/web/api/deploys";
import {
  DeploymentActor,
  DurationText,
  useDurationText,
  ViewLogButton,
} from "./deployment-parts";
import { FirstBuild, WaitingForFirstBuild } from "./first-build";
import { TimelineRowMenu } from "./row-menu";
import type { CardActions } from "./target-header";
import {
  commonTagPrefix,
  deploymentDurationMs,
  elapsedMs,
  logDeployment,
  PAGE_FIRST,
  type RowActionPlan,
  rowActions,
  shortSha,
  type TimelineDeployment,
  type TimelineRow,
} from "./timeline-model";

type Deployment = DeployTargetState["recentDeployments"][number];

/** Rows shown at first, and how many more each "Show more" adds. */
export const PAGE_MORE = 20;

const ELAPSED_TICK_MS = 1000;

export type TimelineContext = Parameters<typeof rowActions>[1];

/**
 * One row per tag (builds and deployed tags merged), newest first, each with
 * its status, who deployed it, its earlier deploys and a ⋯ menu.
 */
export function Timeline({
  target,
  rows,
  actions,
  ctx,
  lockedReason,
  queuedHint,
}: {
  target: DeployTargetState;
  rows: TimelineRow[];
  actions: CardActions;
  ctx: TimelineContext;
  // Set while the environment is locked: manual deploys and rollbacks are off.
  lockedReason: string | null;
  // Set while another deploy in the environment runs first.
  queuedHint: string | null;
}) {
  const t = useTranslations("deploys");
  const [shown, setShown] = React.useState(PAGE_FIRST);
  const listRef = React.useRef<HTMLUListElement>(null);
  // Index of the first row a "Show more" click revealed, to move focus onto.
  const [focusIndex, setFocusIndex] = React.useState<number | null>(null);
  const remaining = rows.length - shown;
  // The prefix every tag of this target shares is dropped from the rows.
  const tagPrefix = React.useMemo(
    () => commonTagPrefix(rows.map((row) => row.tag)),
    [rows]
  );
  React.useEffect(() => {
    if (focusIndex === null) return;
    listRef.current
      ?.querySelectorAll<HTMLElement>('[data-slot="timeline-row"]')
      [focusIndex]?.focus();
    setFocusIndex(null);
  }, [focusIndex]);
  const firstBuild = target.repoFullName !== null && (
    <FirstBuild
      componentKey={target.componentKey}
      branch={target.sourceBranch}
      canStart={ctx.canRun}
      deploysOnArrival={target.autoDeploy || target.deployNextBuild}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      {target.deployNextBuild && (
        <WaitingForFirstBuild branch={target.sourceBranch} />
      )}
      {rows.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {t("buildsEmpty", { branch: target.sourceBranch })}
          </p>
          {firstBuild}
        </div>
      ) : (
        <>
          {/* Only deployed tags of other branches: the branch still needs
              its first build before anything new can be deployed. */}
          {target.recentBuilds.length === 0 && firstBuild && (
            <div className="flex justify-end">{firstBuild}</div>
          )}
          <ul
            ref={listRef}
            // biome-ignore lint/a11y/noRedundantRoles: list-none drops the list role in Safari.
            role="list"
            className="flex list-none flex-col divide-y"
          >
            {rows.slice(0, shown).map((row) => (
              <TimelineRowItem
                key={row.tag}
                row={row}
                tagPrefix={tagPrefix}
                plans={rowActions(row, ctx)}
                actions={actions}
                lockedReason={lockedReason}
                queuedHint={queuedHint}
                sourceBranch={target.sourceBranch}
              />
            ))}
          </ul>
          {remaining > 0 && (
            <Button
              variant="link"
              size="sm"
              className="self-start"
              onClick={() => {
                setFocusIndex(shown);
                setShown((n) => n + PAGE_MORE);
              }}
            >
              {t("showMore", { count: Math.min(PAGE_MORE, remaining) })}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function TimelineRowItem({
  row,
  tagPrefix,
  plans,
  actions,
  lockedReason,
  queuedHint,
  sourceBranch,
}: {
  row: TimelineRow;
  tagPrefix: string;
  plans: RowActionPlan[];
  actions: CardActions;
  lockedReason: string | null;
  queuedHint: string | null;
  sourceBranch: string;
}) {
  const t = useTranslations("deploys");
  const sha = shortSha(row.commitSha);
  const shortTag = tagPrefix ? `…${row.tag.slice(tagPrefix.length)}` : row.tag;

  return (
    <li
      // biome-ignore lint/a11y/noRedundantRoles: list-none drops the list role in Safari.
      role="listitem"
      data-slot="timeline-row"
      data-status={row.status}
      // Not a tab stop: "Show more" moves focus here.
      tabIndex={-1}
      className={cn(
        "flex flex-col gap-2 md:flex-row md:items-center md:gap-3",
        "rounded-lg px-2 py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        row.status === "live" && "bg-success/5"
      )}
    >
      {/* Below md the dot, main text and menu share line 1 and the rest
          wraps beneath; from md every child is a cell of the one row. */}
      <div className="flex min-w-0 items-start gap-2 md:contents">
        <span
          data-slot="row-status-dot"
          aria-hidden="true"
          className={cn(
            "mt-1.5 size-2 shrink-0 rounded-full md:mt-0",
            STATUS_DOT[row.status]
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            data-slot="row-title"
            className="truncate text-sm font-medium"
            title={row.commitMessage ?? row.tag}
          >
            {row.commitMessage ?? row.tag}
          </span>
          <span
            data-slot="row-ids"
            className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground"
            title={row.build?.commitAuthorEmail ?? undefined}
          >
            {sha && (
              <code className="shrink-0" title={row.commitSha ?? undefined}>
                {sha}
              </code>
            )}
            <span
              data-slot="row-tag"
              className="min-w-0 truncate"
              title={row.tag}
              aria-hidden={shortTag !== row.tag || undefined}
            >
              {shortTag}
            </span>
            {shortTag !== row.tag && <span className="sr-only">{row.tag}</span>}
            <CopyButton
              value={row.tag}
              label={t("row.copyTag", { tag: row.tag })}
            />
          </span>
        </div>
        <div className="md:order-last">
          <TimelineRowMenu
            row={row}
            plans={plans}
            actions={actions}
            lockedReason={lockedReason}
            queuedHint={queuedHint}
            sourceBranch={sourceBranch}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 ps-4 md:contents">
        <div className="md:w-44 md:shrink-0">
          <RowStatus row={row} onViewLog={actions.viewLog} />
        </div>
        <div className="flex min-w-0 flex-col gap-1 md:w-56 md:shrink-0">
          <SubjectMeta deployment={row.subject} />
          <RowHistory row={row} onViewLog={actions.viewLog} />
        </div>
        <span
          data-slot="row-time"
          className="text-xs text-muted-foreground md:w-24 md:shrink-0 md:text-sm"
        >
          {row.shownAt && <RelativeTime date={row.shownAt} />}
        </span>
      </div>
    </li>
  );
}

const STATUS_DOT: Record<TimelineRow["status"], string> = {
  live: "bg-success",
  previous: "bg-muted-foreground/50",
  lastGood: "bg-muted-foreground/50",
  queued: "bg-sky-500",
  deploying: "bg-sky-500",
  held: "bg-amber-500",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/30",
  deployedEarlier: "bg-muted-foreground/50",
  never: "bg-muted-foreground/20",
};

const INFO_BADGE =
  "border-transparent bg-sky-500/10 text-sky-700 dark:text-sky-400";
const WARNING_BADGE =
  "border-transparent bg-amber-500/10 text-amber-700 dark:text-amber-400";

function StatusLine({
  icon: Icon,
  className,
  iconClassName,
  children,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  className?: string;
  iconClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      <Icon className={cn("size-4 shrink-0", iconClassName)} aria-hidden />
      {children}
    </span>
  );
}

// Always an icon plus text; the deploying and failed states link their log.
function RowStatus({
  row,
  onViewLog,
}: {
  row: TimelineRow;
  onViewLog: CardActions["viewLog"];
}) {
  const t = useTranslations("deploys");
  const log = logDeployment(row);
  const viewLog = log?.runId ? (
    <ViewLogButton
      onClick={() => log.runId && onViewLog({ runId: log.runId, tag: row.tag })}
    />
  ) : null;

  const content = (() => {
    switch (row.status) {
      case "live":
        return (
          <>
            <Badge className="border-transparent bg-success/15 text-success">
              <CheckCircle2 data-icon="inline-start" />
              {t("row.live")}
            </Badge>
            <LaterFailure row={row} onViewLog={onViewLog} />
          </>
        );
      case "previous":
        return (
          <>
            <Badge variant="secondary">
              <History data-icon="inline-start" />
              {t("row.previous")}
            </Badge>
            <LaterFailure row={row} onViewLog={onViewLog} />
          </>
        );
      case "lastGood":
        return (
          <>
            <Badge variant="secondary">
              <ShieldCheck data-icon="inline-start" />
              {t("row.lastGood")}
            </Badge>
            <LaterFailure row={row} onViewLog={onViewLog} />
          </>
        );
      case "queued":
        return (
          <Badge className={INFO_BADGE}>
            <Loader2 data-icon="inline-start" className="animate-spin" />
            {t("row.queued")}
          </Badge>
        );
      case "deploying":
        return (
          <>
            <Badge className={INFO_BADGE}>
              <Loader2 data-icon="inline-start" className="animate-spin" />
              <DeployingLabel deployment={row.subject} />
            </Badge>
            {viewLog}
          </>
        );
      case "held":
        return (
          <Badge className={WARNING_BADGE}>
            <Lock data-icon="inline-start" />
            {t("row.held")}
          </Badge>
        );
      case "failed":
        return (
          <>
            <Badge variant="destructive">
              <CircleAlert data-icon="inline-start" />
              {t("row.failed")}
            </Badge>
            {viewLog}
          </>
        );
      case "skipped":
        return (
          <Badge variant="outline">
            <SkipForward data-icon="inline-start" />
            {t("row.skipped")}
          </Badge>
        );
      case "deployedEarlier":
        return (
          <>
            <Badge variant="secondary">
              <CheckCircle2 data-icon="inline-start" />
              {t("row.deployedEarlier")}
            </Badge>
            <LaterFailure row={row} onViewLog={onViewLog} />
          </>
        );
      default:
        return (
          <span className="text-sm text-muted-foreground">
            <span aria-hidden="true">—</span>
            <span className="sr-only">{t("row.never")}</span>
          </span>
        );
    }
  })();

  return (
    <div
      data-slot="row-status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
    >
      {content}
    </div>
  );
}

// A failed redeploy after the row's success, so the row shows the failure.
function LaterFailure({
  row,
  onViewLog,
}: {
  row: TimelineRow;
  onViewLog: CardActions["viewLog"];
}) {
  const t = useTranslations("deploys");
  const d = row.laterFailure;
  if (!d) return null;
  return (
    <span
      data-slot="row-later-failure"
      className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"
    >
      <StatusLine icon={CircleAlert} className="text-destructive">
        {t("row.redeployFailed")}
      </StatusLine>
      {d.runId && (
        <ViewLogButton
          onClick={() => d.runId && onViewLog({ runId: d.runId, tag: d.tag })}
        />
      )}
    </span>
  );
}

// Ticks every second while mounted, so only deploying rows re-render.
function DeployingLabel({
  deployment,
}: {
  deployment: TimelineDeployment | null;
}) {
  const t = useTranslations("deploys");
  const now = useNow({ updateInterval: ELAPSED_TICK_MS });
  const duration = useDurationText();
  const elapsed = deployment ? elapsedMs(deployment, now) : null;
  if (elapsed === null) return t("row.deployingNoTime");
  return t("row.deploying", { elapsed: duration(Math.max(0, elapsed)) ?? "" });
}

// Who deployed, how (an auto deploy's actor already says so) and how long it took.
function SubjectMeta({
  deployment: d,
}: {
  deployment: TimelineDeployment | null;
}) {
  const t = useTranslations("deploys");
  if (!d) return null;
  const duration = deploymentDurationMs(d);
  return (
    <span
      data-slot="row-meta"
      className="flex min-w-0 items-center gap-x-1.5 whitespace-nowrap text-xs text-muted-foreground"
    >
      {/* One line: a long name truncates, the trigger and duration stay. */}
      <span data-slot="row-actor" className="flex min-w-0 items-center">
        <DeploymentActor deployment={d} />
      </span>
      {d.trigger !== "auto" && (
        <>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{t(`trigger.${d.trigger}`)}</span>
        </>
      )}
      {duration !== null && (
        <>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">
            <DurationText ms={duration} />
          </span>
        </>
      )}
    </span>
  );
}

// The tag's other deployments, so the history of who deployed what stays.
function RowHistory({
  row,
  onViewLog,
}: {
  row: TimelineRow;
  onViewLog: CardActions["viewLog"];
}) {
  const t = useTranslations("deploys");
  if (row.deployments.length < 2) return null;
  const shownId = row.subject?.id ?? row.deployments[0]?.id;
  const earlier = row.deployments.filter((d) => d.id !== shownId);
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="group/history -ms-2 self-start text-muted-foreground"
          />
        }
      >
        {t("row.history", { count: earlier.length })}
        <ChevronDown
          data-icon="inline-end"
          className="transition-transform group-data-[panel-open]/history:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex list-none flex-col gap-1.5 pt-1">
          {earlier.map((d) => {
            const duration = deploymentDurationMs(d);
            return (
              <li
                key={d.id}
                data-slot="history-entry"
                className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
              >
                <DeploymentStatusBadge status={d.status} />
                <span>{t(`trigger.${d.trigger}`)}</span>
                <span aria-hidden="true">·</span>
                <DeploymentActor deployment={d} />
                <span aria-hidden="true">·</span>
                <RelativeTime date={d.createdAt} />
                {duration !== null && (
                  <>
                    <span aria-hidden="true">·</span>
                    <DurationText ms={duration} />
                  </>
                )}
                {d.runId && (
                  <ViewLogButton
                    onClick={() =>
                      d.runId && onViewLog({ runId: d.runId, tag: d.tag })
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DeploymentStatusBadge({ status }: { status: Deployment["status"] }) {
  const t = useTranslations("deploys");
  const label = t(`status.${status}`);
  switch (status) {
    case "success":
      return (
        <Badge className="bg-success/15 text-success border-transparent">
          <CheckCircle2 data-icon="inline-start" />
          {label}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          <CircleAlert data-icon="inline-start" />
          {label}
        </Badge>
      );
    case "running":
      return (
        <Badge variant="secondary">
          <Loader2 data-icon="inline-start" className="animate-spin" />
          {label}
        </Badge>
      );
    case "superseded":
      return <Badge variant="outline">{label}</Badge>;
    case "held":
      return (
        <Badge variant="outline">
          <Lock data-icon="inline-start" />
          {label}
        </Badge>
      );
    default:
      return <Badge variant="secondary">{label}</Badge>;
  }
}
