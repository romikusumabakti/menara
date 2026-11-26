import { resolveProjectSources as defaultResolveProjectSources } from "./project-sources";
import {
  ensureSnapshot as defaultEnsureSnapshot,
  type Snapshot,
  SnapshotUnavailableError,
} from "./snapshot";
import type { AssistantSource } from "./sources";
import type { PromptSource } from "./system-prompt";
import type { ListedProject, ToolContext } from "./tool-defs";
import type { SnapshotRef } from "./tools/code";
import { createDataTurn } from "./tools/data";
import { projectRef } from "./tools/links";
import {
  type AssistantViewer,
  loadProjectEntries,
  type ProjectEntry,
  visibleProjects,
} from "./viewer";

/** What the automatic context needs to open a project's snapshots. */
export type AutoSourceDeps = {
  resolveProjectSources: (projectId: string) => Promise<AssistantSource[]>;
  ensureSnapshot: (source: AssistantSource) => Promise<Snapshot>;
  loadProjects: () => Promise<ProjectEntry[]>;
};

/**
 * Downloads (or finds in the cache) the snapshot of each source, in
 * parallel, keeping their order: the prompt line of each (with the commit
 * read, or why it is unavailable) and the snapshots the tools may read.
 */
export async function snapshotSources(
  sources: AssistantSource[],
  ensureSnapshot: AutoSourceDeps["ensureSnapshot"]
): Promise<{ prompt: PromptSource[]; snaps: SnapshotRef[] }> {
  // Downloads run in parallel; the order of the sources is kept.
  type Outcome =
    | { source: AssistantSource; snap: Snapshot }
    | { source: AssistantSource; reason: string };
  const outcomes = await Promise.all(
    sources.map(async (source): Promise<Outcome> => {
      try {
        return { source, snap: await ensureSnapshot(source) };
      } catch (error) {
        if (error instanceof SnapshotUnavailableError) {
          return { source, reason: error.reason };
        }
        console.error(
          `[assistant] snapshot of ${source.repoFullName}@${source.ref} failed`,
          error
        );
        return { source, reason: "download-failed" };
      }
    })
  );
  const prompt: PromptSource[] = [];
  const snaps: SnapshotRef[] = [];
  for (const outcome of outcomes) {
    const { source } = outcome;
    if ("snap" in outcome) {
      prompt.push({ ...source, commitSha: outcome.snap.commitSha });
      snaps.push({
        componentKey: source.componentKey,
        dir: outcome.snap.dir,
        commitSha: outcome.snap.commitSha,
      });
    } else {
      prompt.push({ ...source, unavailableReason: outcome.reason });
    }
  }
  return { prompt, snaps };
}

/** A source as stored on the answer: unavailable ones keep a null commit. */
export function storedSource({
  unavailableReason,
  ...source
}: PromptSource): AssistantSource {
  return unavailableReason ? { ...source, commitSha: null } : source;
}

/** Projects whose sources list_projects resolves at once. */
const LIST_PROJECTS_CONCURRENCY = 4;

/**
 * The cached promise for `key`, else a new one from `load`. A rejected
 * promise is dropped, so a transient failure can be retried in the turn.
 */
function memoised<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = load();
  cache.set(key, pending);
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

/** `fn` over `items` with at most `limit` running at once; order kept. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

/**
 * The automatic context's project access for one turn. A key resolves only
 * against the viewer's visible projects (`projects`, already filtered); each
 * project's sources are resolved, and its snapshots fetched, once per turn
 * however many calls name it. The sources of every project opened are
 * written to the answer as they are opened, tagged with their project, so
 * the answer lists what was read even if the turn fails later; a read waits
 * for that write. `onOpened` receives the whole list after each project
 * opens (the Assistant saves it on the answer); the MCP server passes none.
 */
export function projectAccess(
  projects: ProjectEntry[],
  deps: AutoSourceDeps,
  onOpened?: (opened: AssistantSource[]) => Promise<void>
): Pick<
  Extract<ToolContext, { mode: "auto" }>,
  "snapshotsFor" | "listProjects"
> {
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const sourcesOf = new Map<string, Promise<AssistantSource[]>>();
  const snapsOf = new Map<string, Promise<SnapshotRef[]>>();
  let opened: AssistantSource[] = [];
  let saving: Promise<void> = Promise.resolve();

  const sources = (project: ProjectEntry) =>
    memoised(sourcesOf, project.id, () =>
      deps.resolveProjectSources(project.id)
    );

  const open = async (project: ProjectEntry): Promise<SnapshotRef[]> => {
    const { prompt, snaps } = await snapshotSources(
      await sources(project),
      deps.ensureSnapshot
    );
    const tagged = prompt.map((source) => ({
      ...storedSource(source),
      projectKey: project.key,
      projectName: project.name,
    }));
    // Chained, so writes run one at a time and each extends the last list
    // written. A project joins the list only once its write succeeded: a
    // failed write fails its own read, and the retried load adds it again
    // without a duplicate.
    const write = saving
      .catch(() => {})
      .then(async () => {
        const next = [...opened, ...tagged];
        await onOpened?.(next);
        opened = next;
      });
    saving = write;
    await write;
    return snaps;
  };

  return {
    snapshotsFor: (projectKey) => {
      const project = byKey.get(projectKey);
      if (!project) return Promise.resolve({ error: "unknown_project" });
      return memoised(snapsOf, project.id, () => open(project));
    },
    listProjects: () =>
      mapLimit(
        projects,
        LIST_PROJECTS_CONCURRENCY,
        async (project): Promise<ListedProject> => ({
          ...projectRef(project),
          group: project.group,
          description: project.description,
          components: (await sources(project)).map((s) => s.componentKey),
        })
      ),
  };
}

/**
 * The automatic context for a viewer outside a chat turn (the MCP server):
 * the projects they can see, no ticked attachments or uploads, and no files
 * read natively. Sources opened by a read are not recorded anywhere.
 */
export async function createAutoToolContext(
  viewer: AssistantViewer,
  opts: { timeZone: string }
): Promise<Extract<ToolContext, { mode: "auto" }>> {
  const deps: AutoSourceDeps = {
    resolveProjectSources: defaultResolveProjectSources,
    ensureSnapshot: (source) => defaultEnsureSnapshot(source),
    loadProjects: loadProjectEntries,
  };
  const projects = visibleProjects(viewer, await deps.loadProjects());
  return {
    mode: "auto",
    viewer,
    attachments: [],
    uploads: [],
    nativeFiles: false,
    data: createDataTurn(viewer, {
      projects: async () => projects,
      timeZone: opts.timeZone,
    }),
    ...projectAccess(projects, deps),
  };
}
