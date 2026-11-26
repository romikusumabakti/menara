import { Skeleton } from "@/components/ui/skeleton";

// Shaped like the landing: title, search box, then the recently updated rows.
export function KnowledgeLandingPending() {
  return (
    <div className="h-full overflow-y-auto px-4 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-6 pt-10 pb-[12vh]">
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-32" />
          {Array.from({ length: 4 }, (_, i) => (
            <div key={`row-${i}`} className="flex items-center gap-3 px-3 py-2">
              <Skeleton className="size-4 shrink-0" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
