import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { DEFAULT_APP_NAME } from "@/lib/brand-logos";
import { UPSTREAM_REPO_URL } from "@/lib/upstream";
import { cn } from "@/lib/utils";
import { useBootstrap } from "@/web/api/session";

const linkClass = "underline-offset-4 hover:text-foreground hover:underline";

/**
 * The public pages' footer line: "© 2026 {company}", then "Powered by Menara"
 * linking to the upstream repository, so a rebranded instance still says what
 * it runs on. An unbranded instance already reads "© 2026 Menara", so its
 * name is the link instead.
 */
export function Copyright({ className }: { className?: string }) {
  const t = useTranslations("about");
  const { appName, companyName } = useBootstrap();
  const holder = companyName ?? appName;
  const year = new Date().getFullYear();
  const menaraLink = (chunks: ReactNode) => (
    <a
      href={UPSTREAM_REPO_URL}
      target="_blank"
      rel="noreferrer"
      className={linkClass}
    >
      {chunks}
    </a>
  );
  return (
    <p className={cn("text-xs text-muted-foreground text-center", className)}>
      © {year}{" "}
      {holder === DEFAULT_APP_NAME ? (
        menaraLink(holder)
      ) : (
        <>
          {holder} · {t.rich("poweredBy", { link: menaraLink })}
        </>
      )}
    </p>
  );
}
