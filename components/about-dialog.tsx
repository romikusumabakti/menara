import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Code } from "lucide-react";
import { useTranslations } from "use-intl";
import { BrandLogoView } from "@/components/brand-mark";
import { buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DEFAULT_APP_NAME } from "@/lib/brand-logos";
import {
  releaseNotesUrl,
  UPSTREAM_ISSUES_URL,
  UPSTREAM_REPO_URL,
} from "@/lib/upstream";
import { parseVersion } from "@/lib/version";
import { getAboutQuery } from "@/web/api/about";
import { useBootstrap } from "@/web/api/session";

/**
 * What this instance runs on. Admin › Branding may rename the instance and
 * replace its logo, so this dialog is where Menara keeps its own name and
 * mark, the running version, the licence and the upstream repository.
 */
export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("about");
  const { appName } = useBootstrap();
  const about = useQuery({ ...getAboutQuery(), enabled: open });
  const version = about.data?.version;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="items-center text-center">
          {/* Always the built-in mark, whatever logo the instance uploaded;
              at twice its 24px grid so it stays on whole pixels. */}
          <BrandLogoView logo={null} className="size-14 [&_svg]:size-12!" />
          <DialogTitle>{DEFAULT_APP_NAME}</DialogTitle>
          <DialogDescription>{t("tagline")}</DialogDescription>
        </DialogHeader>
        {appName !== DEFAULT_APP_NAME ? (
          <p className="text-center text-sm text-muted-foreground">
            {t("runsOn")}
          </p>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border p-3 text-sm">
          <dt className="text-muted-foreground">{t("version")}</dt>
          <dd className="text-end tabular-nums" data-slot="about-version">
            {version === undefined ? (
              <span className="text-muted-foreground">…</span>
            ) : parseVersion(version) ? (
              <a
                href={releaseNotesUrl(version)}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline-offset-4 hover:underline"
              >
                {version}
              </a>
            ) : (
              t("devBuild")
            )}
          </dd>
          <dt className="text-muted-foreground">{t("license")}</dt>
          <dd className="text-end">MIT</dd>
        </dl>
        <DialogFooter className="sm:justify-center">
          {/* Plain links styled as buttons: they leave the app, so they keep
              the link role (Base UI's Button would make them role=button). */}
          <a
            href={UPSTREAM_ISSUES_URL}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "outline" })}
          >
            <CircleAlert />
            {t("reportIssue")}
          </a>
          <a
            href={UPSTREAM_REPO_URL}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants()}
          >
            <Code />
            {t("sourceCode")}
          </a>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
