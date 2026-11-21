import { eq } from "drizzle-orm";
import {
  type BitbucketAuth,
  FILE_TOO_LARGE,
  listBranches,
  listRepoDir,
  readRepoFileOrLarge,
} from "@/lib/ci/forges/bitbucket";
import {
  menaraSecretName,
  NOTIFY_SECRET_EVENTS,
} from "@/lib/ci/register-artifact-component";
import { CiProviderError } from "@/lib/ci/types";
import { appComponents } from "@/lib/db/schema";
import type { RemarkContext, RemarkItem } from "@/lib/remark/types";
import { messageOf } from "@/lib/remark/types";
import { decryptSecret } from "@/lib/secrets";
import {
  getForgeCredentials,
  getProviderForConnection,
} from "@/server/services/ci-connections";

// Step woodpecker: a component of this instance whose notify secret lives in
// a Woodpecker repo secret named under the previous product
// (`<legacy>_notify`, `<legacy>_notify_<key>`) gets the same value under the
// Menara name (`menara_notify`, `menara_notify_<key>`), and its row then names
// the new secret. One item per (repository, secret name): components sharing
// a secret move together. The legacy secret stays, since pipeline files
// committed to the repository's branches still read it; `remark --finish`
// deletes it once no branch does. A component whose repository is not
// activated in Woodpecker yet has no secret there: only its row is renamed.
//
// The secret value is the component's notify secret, decrypted from its row;
// it is sent to Woodpecker only and never appears in an item or message.

type Component = typeof appComponents.$inferSelect;

const repoTarget = (connectionId: string, ciRepoId: string) =>
  `ci/${connectionId}/repos/${ciRepoId}`;
const componentTarget = (componentKey: string) =>
  `app_components/${componentKey}`;

const REPO_TARGET = /^ci\/([0-9a-f-]+)\/repos\/([^/]+)$/i;
const COMPONENT_TARGET = /^app_components\/([^/]+)$/;

function targetOf(row: Component): string {
  return row.ciRepoId
    ? repoTarget(row.ciConnectionId, row.ciRepoId)
    : componentTarget(row.componentKey);
}

export async function plan(ctx: RemarkContext): Promise<RemarkItem[]> {
  const rows = await ctx.db.select().from(appComponents);
  const items = new Map<string, RemarkItem>();
  for (const row of rows) {
    const to = menaraSecretName(row.notifySecretName, ctx.legacy);
    if (!to) continue;
    const target = targetOf(row);
    const key = `${target}|${row.notifySecretName}`;
    if (!items.has(key)) {
      items.set(key, {
        step: "woodpecker",
        target,
        from: row.notifySecretName,
        to,
      });
    }
  }
  return [...items.values()];
}

/** The one notify secret the components hold; refuses differing ones. */
function sharedValue(rows: Component[], name: string): string {
  const values = new Set(rows.map((r) => decryptSecret(r.notifySecret)));
  if (values.size !== 1) {
    throw new Error(
      `the components ${rows.map((r) => r.componentKey).join(", ")} share ${name} but hold different notify secrets; rotate them so they match, then run remark again`
    );
  }
  return [...values][0] as string;
}

export async function apply(
  ctx: RemarkContext,
  item: RemarkItem
): Promise<void> {
  if (menaraSecretName(item.from, ctx.legacy) !== item.to) {
    throw new Error("the item's secret names are not a legacy conversion");
  }
  const repo = REPO_TARGET.exec(item.target);
  const single = COMPONENT_TARGET.exec(item.target);
  if (!repo && !single) throw new Error(`no such target: ${item.target}`);
  const all = await ctx.db.select().from(appComponents);
  const here = all.filter((r) => targetOf(r) === item.target);
  const rows = here.filter((r) => r.notifySecretName === item.from);
  // Converted by an earlier run.
  if (rows.length === 0) return;

  if (repo) {
    const [, connectionId, ciRepoId] = repo as unknown as [
      string,
      string,
      string,
    ];
    // A component already on the new name shares the secret: same value only.
    const taken = here.filter((r) => r.notifySecretName === item.to);
    const value = sharedValue([...rows, ...taken], item.to);
    const provider = await getProviderForConnection(connectionId);
    try {
      await provider.upsertRepoSecret(
        ciRepoId,
        item.to,
        value,
        NOTIFY_SECRET_EVENTS
      );
    } catch (error) {
      // Provider errors may echo the request body: report the step only.
      throw new Error(
        `storing the Woodpecker secret ${item.to} failed${
          error instanceof CiProviderError ? ` (HTTP ${error.status})` : ""
        }`
      );
    }
  }
  await ctx.db.transaction(async (tx) => {
    for (const r of rows) {
      await tx
        .update(appComponents)
        .set({ notifySecretName: item.to })
        .where(eq(appComponents.componentKey, r.componentKey));
    }
  });
}

// --- remark --finish ---

/**
 * The places Woodpecker reads a pipeline from: `.woodpecker/*.yaml|yml`
 * (when the folder exists it is used alone), else `.woodpecker.yaml`, else
 * `.woodpecker.yml`. All are read, so a secret a custom pipeline uses is
 * never taken for unused.
 */
const PIPELINE_FILES = [".woodpecker.yaml", ".woodpecker.yml"];
const PIPELINE_DIR = ".woodpecker";

export type FinishEntry = {
  /** `ci/<connection>/repos/<ciRepoId>`. */
  target: string;
  repo: string;
  secret: string;
  /** unused: a dry run would delete it; deleted / failed: --apply. */
  status: "kept" | "unused" | "deleted" | "failed";
  /** Branches whose pipeline files still name the secret. */
  branches: string[];
  reason?: string;
};

export type FinishReport = {
  apply: boolean;
  entries: FinishEntry[];
  /** Repositories that could not be read at all. */
  errors: { target: string; message: string }[];
  failed: boolean;
};

const tokenPattern = (name: string) =>
  new RegExp(
    `(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`
  );

/** The pipeline file contents of one branch; FILE_TOO_LARGE fails closed. */
async function pipelineFiles(
  auth: BitbucketAuth,
  repo: string,
  branch: string
): Promise<(string | typeof FILE_TOO_LARGE)[]> {
  const paths = [
    ...PIPELINE_FILES,
    ...(await listRepoDir(auth, repo, branch, PIPELINE_DIR))
      .filter((e) => e.type === "file" && /\.ya?ml$/.test(e.path))
      .map((e) => e.path),
  ];
  const out: (string | typeof FILE_TOO_LARGE)[] = [];
  for (const path of paths) {
    const content = await readRepoFileOrLarge(auth, repo, branch, path);
    if (content !== null) out.push(content);
  }
  return out;
}

type ManagedRepo = {
  connectionId: string;
  ciRepoId: string;
  repo: string;
  rows: Component[];
};

function managedRepos(rows: Component[]): ManagedRepo[] {
  const repos = new Map<string, ManagedRepo>();
  for (const row of rows) {
    if (!row.ciRepoId) continue;
    const key = repoTarget(row.ciConnectionId, row.ciRepoId);
    const entry = repos.get(key) ?? {
      connectionId: row.ciConnectionId,
      ciRepoId: row.ciRepoId,
      repo: row.repoFullName,
      rows: [],
    };
    entry.rows.push(row);
    repos.set(key, entry);
  }
  return [...repos.values()];
}

/**
 * For each legacy notify secret still in a CI repository this instance
 * manages: the branches whose pipeline files still name it. A secret no
 * branch names (and no component row uses) is unused; with `apply` it is
 * deleted. Anything that could not be checked is kept.
 */
export async function finish(
  ctx: Omit<RemarkContext, "log">,
  opts: { apply: boolean }
): Promise<FinishReport> {
  const entries: FinishEntry[] = [];
  const errors: FinishReport["errors"] = [];
  const rows = await ctx.db.select().from(appComponents);
  for (const managed of managedRepos(rows)) {
    const target = repoTarget(managed.connectionId, managed.ciRepoId);
    const base = { target, repo: managed.repo };
    let provider: Awaited<ReturnType<typeof getProviderForConnection>>;
    let legacyNames: string[];
    try {
      provider = await getProviderForConnection(managed.connectionId);
      legacyNames = (await provider.listRepoSecrets(managed.ciRepoId)).filter(
        (name) => menaraSecretName(name, ctx.legacy) !== null
      );
    } catch (error) {
      errors.push({ target, message: messageOf(error) });
      continue;
    }
    if (legacyNames.length === 0) continue;

    const keep = (secret: string, reason: string, branches: string[] = []) =>
      entries.push({ ...base, secret, status: "kept", branches, reason });
    const unconverted = (secret: string) =>
      managed.rows
        .filter((r) => r.notifySecretName === secret)
        .map((r) => r.componentKey);

    let auth: BitbucketAuth | null = null;
    let forgeProblem: string | null = null;
    try {
      const credentials = await getForgeCredentials(managed.connectionId);
      if (credentials.forge !== "bitbucket") {
        forgeProblem = `reading ${credentials.forge} branches is not supported`;
      } else if (!credentials.auth) {
        forgeProblem = "the CI connection has no forge username and token";
      } else auth = credentials.auth;
    } catch (error) {
      forgeProblem = `the forge credentials could not be read (${messageOf(error)})`;
    }

    // Each branch's pipeline files, read once for every secret of the repo.
    let files: Map<string, (string | typeof FILE_TOO_LARGE)[]> | null = null;
    if (auth) {
      try {
        files = new Map();
        for (const branch of await listBranches(auth, managed.repo)) {
          files.set(branch, await pipelineFiles(auth, managed.repo, branch));
        }
      } catch (error) {
        files = null;
        forgeProblem = `the branches could not be read (${messageOf(error)})`;
      }
    }

    for (const secret of legacyNames) {
      const users = unconverted(secret);
      if (users.length > 0) {
        keep(
          secret,
          `components ${users.join(", ")} still use it; run remark --step woodpecker --apply first`
        );
        continue;
      }
      if (!files) {
        keep(secret, forgeProblem ?? "the branches could not be read");
        continue;
      }
      const pattern = tokenPattern(secret);
      const branches = [...files.entries()]
        .filter(([, contents]) =>
          contents.some((c) => c === FILE_TOO_LARGE || pattern.test(c))
        )
        .map(([branch]) => branch);
      if (branches.length > 0) {
        keep(
          secret,
          "branches still reference it; update their pipeline files",
          branches
        );
        continue;
      }
      if (!opts.apply) {
        entries.push({ ...base, secret, status: "unused", branches: [] });
        continue;
      }
      try {
        await provider.deleteRepoSecret(managed.ciRepoId, secret);
        entries.push({ ...base, secret, status: "deleted", branches: [] });
      } catch (error) {
        entries.push({
          ...base,
          secret,
          status: "failed",
          branches: [],
          reason: messageOf(error),
        });
      }
    }
  }
  return {
    apply: opts.apply,
    entries,
    errors,
    failed: errors.length > 0 || entries.some((e) => e.status === "failed"),
  };
}

/** The --finish report as the CLI prints it, one line per secret. */
export function formatFinishReport(report: FinishReport): string[] {
  const lines = [
    report.apply
      ? "menara remark --finish --apply"
      : "menara remark --finish (dry run: nothing was deleted; --apply deletes unused secrets)",
  ];
  for (const e of report.entries) {
    const head = `${e.target} (${e.repo}): ${e.secret}`;
    switch (e.status) {
      case "unused":
        lines.push(`${head}: unused, would be deleted`);
        break;
      case "deleted":
        lines.push(`${head}: deleted`);
        break;
      case "failed":
        lines.push(`${head}: delete failed: ${e.reason}`);
        break;
      case "kept":
        lines.push(
          `${head}: kept, ${e.reason}${e.branches.length ? `: ${e.branches.join(", ")}` : ""}`
        );
        break;
    }
  }
  for (const e of report.errors) {
    lines.push(`${e.target}: could not be read: ${e.message}`);
  }
  if (report.entries.length === 0 && report.errors.length === 0) {
    lines.push("No legacy notify secret is left.");
  }
  return lines;
}
