import { BookOpen } from "lucide-react";
import { useTranslations } from "use-intl";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function ApiDocsSheet({ content }: { content: string }) {
  const t = useTranslations("mockTime.docs");

  return (
    <Sheet>
      <SheetTrigger render={<Button variant="outline" size="sm" />}>
        <BookOpen className="size-4" />
        {t("button")}
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="border-b">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        <Markdown
          mode="static"
          className="px-4 pb-6 text-sm"
          content={content}
        />
      </SheetContent>
    </Sheet>
  );
}
