import {
  CircleAlert,
  GitBranch,
  Loader2,
  Lock,
  Package,
  Rocket,
  Server,
  Undo2,
} from "lucide-react";
import * as React from "react";
import { useFormatter, useTranslations } from "use-intl";
import { useRelativeTimeText } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipHint,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DATE_TIME } from "@/lib/format-date";
import type { DeployTargetState } from "@/web/api/deploys";
import { ViewLogButton } from "./deployment-parts";
import type { HeaderState, TimelineDeployment } from "./timeline-model";

/** A deploy or rollback whose request is in flight. */
export type PendingAction = { kind: "deploy" | "rollback"; tag: string };

/** What the card's controls do; `pending` is the request in flight. */
export type CardActions = {
  deploy(tag: string): Promise<void>;
  rollback(): Promise<void>;
  markRelease(d: TimelineDeployment): void;
  viewLog(d: { runId: string; tag: string }): void;
  pending: PendingAction | null;
};

export type HeaderLock = {
  lockedBy: { name: string } | null;
  reason: string;
  expiresAt: string;
} | null;

// When the deployment ended, or else when it was asked for.
const settledAt = (d: TimelineDeployment) => d.finishedAt ?? d.createdAt;

/**
 * The card header: what runs now (or what failed), the one failure line, the
 * lock, and the primary actions with the reason they are unavailable.
 */
export function TargetHeader({
  target,
  serverName,
  header,
  actions,
  lockedReason,
  lock,
  queuedHint,
  canRun,
  canRollback,
}: {
  target: DeployTargetState;
  serverName: string;
  header: HeaderState;
  actions: CardActions;
  // Set while the environment is locked: manual deploys and rollbacks are off.
  lockedReason: string | null;
  lock: HeaderLock;
  // Set while another deploy in the environment runs first.
  queuedHint: string | null;
  canRun: boolean;
  canRollback: boolean;
}) {
  const t = useTranslations("deploys");
  const deployReasonId = React.useId();
  const rollbackReasonId = React.useId();
  const { pending } = actions;
  const latest = canRun ? header.deployLatest : null;
  const rollbackTag = canRollback ? header.rollbackTag : null;

  // Why each button is off (or, for the queue, when it starts).
  const deployReason = (() => {
    if (!latest) return null;
    if (lockedReason !== null) return lockedReason;
    switch (latest.blocked) {
      case "latestIsLive":
        return t("latestIsLive", { tag: latest.tag });
      case "deploying":
        return t("latestDeploying");
      case "held":
        return t("latestHeld");
      default:
        return queuedHint;
    }
  })();
  const rollbackReason = (() => {
    if (!rollbackTag) return null;
    if (lockedReason !== null) return lockedReason;
    if (header.rollbackBusy) {
      return t("rollbackInProgress", { tag: rollbackTag });
    }
    return queuedHint;
  })();
  // One line when both buttons share the reason.
  const sharedReason = deployReason !== null && deployReason === rollbackReason;
  const reasons = [
    deployReason !== null && { id: deployReasonId, text: deployReason },
    rollbackReason !== null &&
      !sharedReason && { id: rollbackReasonId, text: rollbackReason },
  ].filter((r) => r !== false);

  const deployDisabled =
    latest !== null &&
    (latest.blocked !== null || lockedReason !== null || pending !== null);
  const rollbackDisabled =
    lockedReason !== null || pending !== null || header.rollbackBusy;

  return (
    <CardHeader>
      <CardTitle className="flex flex-wrap items-center gap-2">
        <span className="font-mono">{target.componentKey}</span>
        {target.autoDeploy && (
          <Badge variant="secondary">{t("autoDeploy")}</Badge>
        )}
        {lock && <LockChip lock={lock} />}
      </CardTitle>
      <TargetSubtitle target={target} serverName={serverName} />

      {(latest || rollbackTag) && (
        <CardAction className="col-start-1 row-span-1 row-start-auto flex flex-col items-start gap-1.5 justify-self-start md:col-start-2 md:row-span-2 md:row-start-1 md:items-end md:justify-self-end">
          <div className="flex flex-wrap justify-start gap-2 md:justify-end">
            {rollbackTag && (
              <TooltipHint label={t("rollbackTo", { tag: rollbackTag })}>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t("rollbackTo", { tag: rollbackTag })}
                  disabled={rollbackDisabled}
                  aria-disabled={rollbackDisabled || undefined}
                  aria-describedby={
                    rollbackReason === null
                      ? undefined
                      : sharedReason
                        ? deployReasonId
                        : rollbackReasonId
                  }
                  onClick={() => actions.rollback()}
                >
                  {pending?.kind === "rollback" ? (
                    <Loader2
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : (
                    <Undo2 data-icon="inline-start" />
                  )}
                  {t("rollbackShort")}
                </Button>
              </TooltipHint>
            )}
            {latest && (
              <TooltipHint label={t("deployTag", { tag: latest.tag })}>
                <Button
                  size="sm"
                  aria-label={t("deployLatestLabel", { tag: latest.tag })}
                  disabled={deployDisabled}
                  aria-disabled={deployDisabled || undefined}
                  aria-describedby={
                    deployReason === null ? undefined : deployReasonId
                  }
                  onClick={() => actions.deploy(latest.tag)}
                >
                  {pending?.kind === "deploy" && pending.tag === latest.tag ? (
                    <Loader2
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : (
                    <Rocket data-icon="inline-start" />
                  )}
                  {t("deployLatest")}
                </Button>
              </TooltipHint>
            )}
          </div>
          {reasons.map((r) => (
            <p
              key={r.id}
              id={r.id}
              data-slot="deploy-actions-reason"
              className="max-w-xs text-start text-xs md:text-end text-muted-foreground"
            >
              {r.text}
            </p>
          ))}
        </CardAction>
      )}

      <div className="col-span-full flex flex-col gap-1 text-sm">
        {header.note && (
          <NoteLine
            note={header.note}
            focal={header.focal}
            onViewLog={actions.viewLog}
          />
        )}
        {header.failure && (
          <FailureLine failure={header.failure} onViewLog={actions.viewLog} />
        )}
      </div>
    </CardHeader>
  );
}

// Branch, server, artifact and repo; wraps on narrow screens instead of
// clipping. The full path and the systemd unit sit in the artifact's tooltip.
function TargetSubtitle({
  target,
  serverName,
}: {
  target: DeployTargetState;
  serverName: string;
}) {
  const t = useTranslations("deploys");
  const path =
    target.kind === "jar"
      ? `${target.deployDir}/${target.jarName}`
      : target.deployDir;
  const artifact =
    target.kind === "jar"
      ? target.jarName
      : (target.deployDir.split("/").filter(Boolean).pop() ?? target.deployDir);
  const unit = target.kind === "jar" ? target.systemdUnit : null;
  // The tooltip is pointer/focus only; this is what a screen reader announces.
  const artifactLabel = [
    artifact,
    path,
    unit ? t("serviceUnit", { unit }) : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <MetaItem icon={<GitBranch aria-hidden />}>
        <code className="font-mono">{target.sourceBranch}</code>
      </MetaItem>
      {serverName && (
        <MetaItem icon={<Server aria-hidden />}>{serverName}</MetaItem>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard focus target for the path tooltip
              tabIndex={0}
              role="group"
              aria-label={artifactLabel}
              className="inline-flex items-center gap-1 break-all"
            />
          }
        >
          <Package className="size-3.5 shrink-0" aria-hidden />
          <code className="font-mono">{artifact}</code>
        </TooltipTrigger>
        <TooltipContent className="flex-col items-start font-mono">
          <span>{path}</span>
          {unit && <span>{t("serviceUnit", { unit })}</span>}
        </TooltipContent>
      </Tooltip>
      {target.repoFullName && (
        <code className="font-mono" title={t("serviceRepo")}>
          {target.repoFullName}
        </code>
      )}
    </CardDescription>
  );
}

function MetaItem({
  icon,
  children,
}: {
  icon: React.ReactElement;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      {React.cloneElement(icon as React.ReactElement<{ className?: string }>, {
        className: "size-3.5 shrink-0",
      })}
      {children}
    </span>
  );
}

// The states no Live row carries: the current deploy failed, or none ran yet.
function NoteLine({
  note,
  focal,
  onViewLog,
}: {
  note: NonNullable<HeaderState["note"]>;
  focal: HeaderState["focal"];
  onViewLog: CardActions["viewLog"];
}) {
  const t = useTranslations("deploys");
  const format = useFormatter();
  const relative = useRelativeTimeText();

  if (note.kind === "neverDeployed") {
    return (
      <p data-slot="deploy-note" className="italic text-muted-foreground">
        {t("neverDeployed")}
      </p>
    );
  }
  if (note.kind === "lastLive") {
    return (
      <p data-slot="deploy-note" className="text-muted-foreground">
        {t("liveNote", { tag: note.tag })}
      </p>
    );
  }
  if (focal.kind !== "failedCurrent") return null;
  const d = focal.deployment;
  return (
    <div
      data-slot="deploy-note"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-destructive"
    >
      <CircleAlert className="size-4 shrink-0" aria-hidden />
      <span
        title={
          d ? format.dateTime(new Date(settledAt(d)), DATE_TIME) : undefined
        }
      >
        {d
          ? t("focalFailed", { tag: focal.tag, time: relative(settledAt(d)) })
          : t("focalFailedNoTime", { tag: focal.tag })}
      </span>
      {note.lastGoodTag && (
        <span>{t("focalLastGood", { tag: note.lastGoodTag })}</span>
      )}
      {d?.runId && (
        <ViewLogButton
          onClick={() => d.runId && onViewLog({ runId: d.runId, tag: d.tag })}
        />
      )}
    </div>
  );
}

function FailureLine({
  failure,
  onViewLog,
}: {
  failure: NonNullable<HeaderState["failure"]>;
  onViewLog: CardActions["viewLog"];
}) {
  const t = useTranslations("deploys");
  const format = useFormatter();
  const relative = useRelativeTimeText();
  const d = failure.deployment;
  return (
    <div
      data-slot="deploy-failure"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-destructive"
    >
      <CircleAlert className="size-4 shrink-0" aria-hidden />
      <span title={format.dateTime(new Date(settledAt(d)), DATE_TIME)}>
        {t("failureLine", { tag: failure.tag, time: relative(settledAt(d)) })}
      </span>
      {d.runId && (
        <ViewLogButton
          onClick={() => d.runId && onViewLog({ runId: d.runId, tag: d.tag })}
        />
      )}
    </div>
  );
}

// Who holds the lock and until when; the reason in the tooltip and, for
// screen readers, in the chip's description.
function LockChip({ lock }: { lock: NonNullable<HeaderLock> }) {
  const t = useTranslations("deploys");
  const format = useFormatter();
  const reasonId = React.useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge
              variant="outline"
              tabIndex={0}
              aria-describedby={reasonId}
              className="h-auto whitespace-normal"
            />
          }
        >
          <Lock data-icon="inline-start" />
          {t("lockChip", {
            name: lock.lockedBy?.name || t("lock.holderUnknown"),
            time: format.dateTime(new Date(lock.expiresAt), DATE_TIME),
          })}
        </TooltipTrigger>
        <TooltipContent>{lock.reason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {lock.reason}
      </span>
    </>
  );
}
