import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const CARDS = 2;
const ROWS = 5;

/** Loading state shaped like the target cards: header, then two-line rows. */
export function DeploysPending() {
  return (
    <>
      <PageHeaderSkeleton withAction />
      <div className="flex flex-col gap-4">
        {Array.from({ length: CARDS }, (_, card) => (
          <Card key={card}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-72 max-w-full" />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {Array.from({ length: ROWS }, (_, row) => (
                <div
                  key={row}
                  data-slot="timeline-row-skeleton"
                  className="flex items-center gap-3"
                >
                  <Skeleton className="size-2.5 shrink-0 rounded-full" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
