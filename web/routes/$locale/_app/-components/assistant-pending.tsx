import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceLayout } from "@/components/workspace-layout";

// Built on the same WorkspaceLayout as the page itself, so the shell does not
// jump when the data arrives: conversation list beside the thread and composer.
export function AssistantPending() {
  return (
    <WorkspaceLayout
      sidebar={
        <div className="flex max-h-40 min-h-0 flex-1 flex-col gap-2 overflow-hidden p-4 lg:max-h-none">
          <Skeleton data-slot="sidebar-skeleton-row" className="h-8 w-full" />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton
              key={`conversation-${i}`}
              data-slot="sidebar-skeleton-row"
              className="h-10 w-full"
            />
          ))}
        </div>
      }
    >
      <div
        data-slot="main-skeleton"
        className="flex min-h-0 flex-1 flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8"
      >
        <Skeleton className="min-h-0 flex-1 rounded-lg" />
        <Skeleton className="h-24 shrink-0 rounded-lg" />
      </div>
    </WorkspaceLayout>
  );
}
