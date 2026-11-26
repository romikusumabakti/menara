import type { ReleaseListItem } from "@/web/api/releases";

type VersionRow = Pick<
  ReleaseListItem,
  "componentKey" | "status" | "createdAt"
>;

/** The newest row per component: older rows of a component are superseded. */
export function latestPerComponent<T extends VersionRow>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const current = latest.get(row.componentKey);
    if (
      !current ||
      new Date(row.createdAt).getTime() > new Date(current.createdAt).getTime()
    ) {
      latest.set(row.componentKey, row);
    }
  }
  return [...latest.values()];
}

/**
 * The status of a whole version: the latest row of each component decides, so
 * a failed attempt that a later one replaced no longer fails the version.
 * Failed beats preparing beats ready.
 */
export function versionStatus(
  rows: VersionRow[]
): "ready" | "failed" | "preparing" {
  const latest = latestPerComponent(rows);
  if (latest.some((r) => r.status === "failed")) return "failed";
  if (latest.some((r) => r.status === "preparing")) return "preparing";
  return "ready";
}
