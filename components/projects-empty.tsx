import { FolderPlus } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { ProjectCreateDialog } from "@/components/project-create-dialog";
import { ProjectGroupsButton } from "@/components/project-groups-dialog";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

// Shown when no logical project exists yet. The first step is creating the
// project, not a deployment — environments are added from its card afterwards.
export function ProjectsEmpty({
  canCreate,
  canManageGroups = false,
}: {
  canCreate: boolean;
  /** Admins can set groups up before the first project exists. */
  canManageGroups?: boolean;
}) {
  const t = useTranslations("projectsEmpty");
  const [open, setOpen] = useState(false);

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderPlus />
          </EmptyMedia>
          <EmptyTitle>{t("title")}</EmptyTitle>
          <EmptyDescription>{t("description")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="empty:hidden">
          {canCreate ? (
            <div className="flex items-center gap-2">
              {canManageGroups && <ProjectGroupsButton />}
              <Button onClick={() => setOpen(true)}>{t("create")}</Button>
            </div>
          ) : undefined}
        </EmptyContent>
      </Empty>
      <ProjectCreateDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={() => {
          setOpen(false);
        }}
      />
    </div>
  );
}
