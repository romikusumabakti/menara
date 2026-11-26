import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

export function SectionError({ compact = false }: { compact?: boolean }) {
  const t = useTranslations("homePage");
  const router = useRouter();
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3 text-sm text-muted-foreground",
        compact ? "py-2" : "py-6"
      )}
    >
      <span>{t("error.load")}</span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => router.refresh({ includeRemote: true })}
      >
        {t("error.retry")}
      </Button>
    </div>
  );
}
