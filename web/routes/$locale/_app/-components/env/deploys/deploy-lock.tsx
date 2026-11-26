import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Lock, LockOpen, ShieldAlert } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "use-intl";
import { useProjectRole } from "@/components/project-role";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  canLock,
  canUnlock,
  defaultLockExpiry,
  LOCK_REASON_MAX,
  lockBannerActions,
} from "@/lib/deploy/lock";
import { canOrg } from "@/lib/permissions";
import { ApiError } from "@/web/api/client";
import {
  forceUnlockEnvironment,
  getDeployLockQuery,
  lockEnvironment,
  unlockEnvironment,
} from "@/web/api/deploy-locks";
import { meQuery } from "@/web/api/session";

/** The environment's deploy lock, refetched while the page is open. */
export function useDeployLock(environmentId: string) {
  return useQuery({
    ...getDeployLockQuery(environmentId),
    refetchInterval: 30_000,
  });
}

// `datetime-local` takes and gives wall-clock time in the browser's zone.
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Small badge for the environment dashboard; nothing while unlocked. */
export function DeployLockBadge({ environmentId }: { environmentId: string }) {
  const t = useTranslations("deploys.lock");
  const lock = useDeployLock(environmentId).data?.lock;
  if (!lock) return null;
  return (
    <Badge variant="secondary">
      <Lock data-icon="inline-start" />
      {t("badge")}
    </Badge>
  );
}

const OPEN_TINT =
  "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
const LOCKED_TINT =
  "border-amber-600/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";

/**
 * The lock state and its controls, for the Deploys page header. Who may do
 * what mirrors the server (lib/deploy/lock, server/services/deploy-locks); the
 * API enforces it anyway.
 */
export function DeployLockControl({
  environmentId,
  ownerId = null,
}: {
  environmentId: string;
  ownerId?: string | null;
}) {
  const t = useTranslations("deploys.lock");
  const format = useFormatter();
  const queryClient = useQueryClient();
  const state = useDeployLock(environmentId).data;
  const me = useQuery(meQuery()).data;
  const role = useProjectRole();
  const [dialog, setDialog] = React.useState<"lock" | "force" | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (!state) return null;
  const lock = state.lock;
  const userId = me?.user.id;
  const isOwner = ownerId !== null && ownerId === userId;
  const mayLock = canLock(role, isOwner);
  const mayUnlock =
    lock !== null && canUnlock(isOwner, lock.lockedBy?.id === userId);
  const mayForce =
    lock !== null && canOrg(me?.orgRole, { integration: ["manage"] });
  const actions = lockBannerActions({ mayLock, mayUnlock, mayForce });
  const held = state.heldCount;

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["deploy-locks"] });
    queryClient.invalidateQueries({ queryKey: ["deploys"] });
  }

  function fail(error: unknown) {
    toast.error(
      error instanceof ApiError || error instanceof Error
        ? error.message
        : t("failed")
    );
    refresh();
  }

  async function onUnlock() {
    setBusy(true);
    try {
      await unlockEnvironment(environmentId);
      toast.success(t("unlocked"));
      refresh();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  const dialogs = (
    <>
      <LockDialog
        open={dialog === "lock"}
        onOpenChange={(open) => !open && setDialog(null)}
        environmentId={environmentId}
        initialReason={lock?.reason ?? ""}
        initialExpiry={lock?.expiresAt ?? null}
        onDone={refresh}
      />
      <ForceUnlockDialog
        open={dialog === "force"}
        onOpenChange={(open) => !open && setDialog(null)}
        environmentId={environmentId}
        onDone={refresh}
      />
    </>
  );

  if (!lock) {
    if (!mayLock && held === 0) return null;
    return (
      <div className="flex items-center gap-2">
        <Badge variant="outline" className={OPEN_TINT}>
          <LockOpen data-icon="inline-start" />
          {held > 0 ? t("openHeld", { count: held }) : t("open")}
        </Badge>
        {mayLock && (
          <Button variant="outline" onClick={() => setDialog("lock")}>
            <Lock data-icon="inline-start" />
            {t("lock")}
          </Button>
        )}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Popover>
        <PopoverTrigger
          render={
            <Badge
              variant="outline"
              className={`cursor-pointer ${LOCKED_TINT}`}
              render={<button type="button" />}
            />
          }
        >
          <Lock data-icon="inline-start" />
          {held > 0 ? t("lockedStateHeld", { count: held }) : t("lockedState")}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <p>
            {t("lockedBy", {
              name: lock.lockedBy?.name || t("holderUnknown"),
              reason: lock.reason,
            })}
          </p>
          <p className="text-muted-foreground">
            {t("until", {
              expiresAt: format.dateTime(new Date(lock.expiresAt), {
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                dateStyle: "medium",
                timeStyle: "short",
              }),
            })}{" "}
            {t("heldBuilds", { count: held })}
          </p>
        </PopoverContent>
      </Popover>
      {actions.unlock && (
        <Button variant="outline" disabled={busy} onClick={onUnlock}>
          <LockOpen data-icon="inline-start" />
          {t("unlock")}
        </Button>
      )}
      {(actions.edit || actions.force) && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="icon"
                aria-label={t("moreActions")}
              />
            }
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.edit && (
              <DropdownMenuItem onClick={() => setDialog("lock")}>
                {t("edit")}
              </DropdownMenuItem>
            )}
            {actions.force && (
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDialog("force")}
              >
                <ShieldAlert />
                {t("forceUnlock")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {dialogs}
    </div>
  );
}

function LockDialog({
  open,
  onOpenChange,
  environmentId,
  initialReason,
  initialExpiry,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  initialReason: string;
  initialExpiry: string | null;
  onDone: () => void;
}) {
  const t = useTranslations("deploys.lock");
  const tCommon = useTranslations("common");
  const [reason, setReason] = React.useState("");
  const [expiry, setExpiry] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Read through a ref so a parent re-render (the lock refetches every 30 s)
  // never resets what the user is typing; only opening the dialog does.
  const initial = React.useRef({
    reason: initialReason,
    expiry: initialExpiry,
  });
  initial.current = { reason: initialReason, expiry: initialExpiry };

  // Start from the current lock (or the default expiry) on every open.
  React.useEffect(() => {
    if (!open) return;
    const current = initial.current;
    setReason(current.reason);
    setExpiry(
      toLocalInput(
        current.expiry
          ? new Date(current.expiry)
          : defaultLockExpiry(new Date())
      )
    );
    setError(null);
  }, [open]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const date = new Date(expiry);
    if (reason.trim() === "" || Number.isNaN(date.getTime())) {
      setError(tCommon("required"));
      return;
    }
    setSaving(true);
    try {
      await lockEnvironment(environmentId, {
        reason: reason.trim(),
        expiresAt: date.toISOString(),
      });
      toast.success(t("locked"));
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("failed"));
    } finally {
      setSaving(false);
      onDone();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="deploy-lock-reason">{t("reason")}</Label>
            <Input
              id="deploy-lock-reason"
              value={reason}
              maxLength={LOCK_REASON_MAX}
              autoComplete="off"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="deploy-lock-expiry">{t("expiry")}</Label>
            <Input
              id="deploy-lock-expiry"
              type="datetime-local"
              min={toLocalInput(new Date())}
              max={toLocalInput(new Date(Date.now() + 7 * 86_400_000))}
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("expiryHint")}</p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {t(initialExpiry ? "saveLock" : "lock")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ForceUnlockDialog({
  open,
  onOpenChange,
  environmentId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  onDone: () => void;
}) {
  const t = useTranslations("deploys.lock");
  const tCommon = useTranslations("common");
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
    }
  }, [open]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (reason.trim() === "") {
      setError(tCommon("required"));
      return;
    }
    setSaving(true);
    try {
      await forceUnlockEnvironment(environmentId, reason.trim());
      toast.success(t("unlocked"));
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("failed"));
    } finally {
      setSaving(false);
      onDone();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("forceTitle")}</DialogTitle>
          <DialogDescription>{t("forceDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="deploy-force-reason">{t("forceReason")}</Label>
            <Input
              id="deploy-force-reason"
              value={reason}
              maxLength={LOCK_REASON_MAX}
              autoComplete="off"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={saving}>
              {t("forceUnlock")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
