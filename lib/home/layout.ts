// Pure decisions for Home's layout and header. Client-safe.

// Four buckets so Indonesian gets pagi/siang/sore/malam; other locales may map
// two buckets to the same phrase.
export type GreetingKey = "morning" | "midday" | "afternoon" | "night";

export function greetingKey(hour: number): GreetingKey {
  if (hour >= 4 && hour < 11) return "morning";
  if (hour >= 11 && hour < 15) return "midday";
  if (hour >= 15 && hour < 18) return "afternoon";
  return "night";
}

/** The wall-clock hour (0–23) of `date` in `timeZone`. */
export function hourIn(timeZone: string, date: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone,
    }).format(date)
  );
}

/** Where "New issue" points by default: the last-opened writable environment. */
export function defaultIssueTarget(
  recent: { id: string; projectId: string }[],
  writableProjectIds: ReadonlySet<string>
): { projectId: string; environmentId: string } | null {
  const env = recent.find((e) => writableProjectIds.has(e.projectId));
  return env ? { projectId: env.projectId, environmentId: env.id } : null;
}
