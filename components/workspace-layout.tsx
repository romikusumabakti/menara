import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared shell for the workspace pages (Knowledge, Assistant): a left sidebar,
// the main column and an optional right aside, filling the viewport below the
// app header and cancelling the page padding.
export function WorkspaceLayout({
  sidebar,
  aside,
  children,
  className,
}: {
  sidebar: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "-mx-4 -my-6 flex h-[calc(100svh-3.5rem)] flex-col overflow-hidden sm:-mx-6 lg:-mx-8 lg:flex-row",
        className
      )}
    >
      <aside className="flex shrink-0 flex-col border-b lg:h-full lg:w-64 lg:border-b-0 lg:border-e">
        {sidebar}
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
      {aside && (
        <aside className="flex shrink-0 flex-col border-t lg:h-full lg:w-96 lg:border-s lg:border-t-0">
          {aside}
        </aside>
      )}
    </div>
  );
}
