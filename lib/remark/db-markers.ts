import {
  databaseHosts,
  environmentServices,
  environments,
  servers,
} from "@/lib/db/schema";
import { dbStdinShellCommand, pgQuoteLiteral } from "@/lib/jobs/commands";
import { privilegedWithStdin } from "@/lib/privileged";
import { provisionedRoleMarker } from "@/lib/provisioning/database";
import type { RemarkContext, RemarkItem } from "@/lib/remark/types";
import { messageOf } from "@/lib/remark/types";
import { decryptNullable } from "@/lib/secrets";
import type { ServiceType } from "@/lib/services";
import { executeRemoteCommand } from "@/lib/ssh";
import { sshTarget } from "@/lib/ssh-connect";

// Step db-markers: every Postgres role Menara marked for one of this
// instance's environments that still carries `<legacy>:<envId>` gets
// `COMMENT ON ROLE … IS 'menara:<envId>'`. Only Postgres roles carry a marker
// (shared-database owners and the Assistant's read-only roles); MySQL and SQL
// Server logins have none. The clusters read are the registered database
// hosts and every other Postgres database with an Assistant login, each once.

/** A Postgres cluster Menara administers as `postgres`, over SSH. */
type PgPlace = {
  ref: string;
  server: {
    id: string;
    host: string;
    username: string;
    password: string | null;
    auth: "password" | "key";
  };
  serviceType: ServiceType;
  serviceName: string;
};

const TIMEOUT_MS = 60_000;
const PSQL = "psql -X -q -At -v ON_ERROR_STOP=on -U postgres -d postgres";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

async function pgPlaces(ctx: RemarkContext): Promise<PgPlace[]> {
  const [hosts, services, serverRows] = await Promise.all([
    ctx.db.select().from(databaseHosts),
    ctx.db.select().from(environmentServices),
    ctx.db.select().from(servers),
  ]);
  const serverById = new Map(serverRows.map((s) => [s.id, s]));
  const places: PgPlace[] = [];
  const seen = new Set<string>();
  const add = (
    ref: string,
    serverId: string,
    serviceType: ServiceType,
    serviceName: string
  ) => {
    const server = serverById.get(serverId);
    const key = `${serverId}|${serviceType}|${serviceName}`;
    if (!server || seen.has(key)) return;
    seen.add(key);
    places.push({
      ref,
      server: {
        id: server.id,
        host: server.host,
        username: server.username,
        password: decryptNullable(server.password),
        auth: server.auth,
      },
      serviceType,
      serviceName,
    });
  };
  for (const h of hosts) {
    add(`database-hosts/${h.id}`, h.serverId, "docker", h.containerName);
  }
  for (const s of services) {
    if (
      s.role === "db" &&
      s.dbType === "postgres" &&
      s.dbKind !== "shared" &&
      s.assistantDbLogin !== null
    ) {
      add(`services/${s.id}`, s.serverId, s.serviceType, s.serviceName);
    }
  }
  return places;
}

/** Runs `sql` (on stdin) as postgres in the place's cluster; returns stdout. */
async function runPg(
  place: PgPlace,
  sql: string,
  opts: { readOnly: boolean }
): Promise<string> {
  const { command, stdin } =
    place.serviceType === "systemd"
      ? privilegedWithStdin(PSQL, place.server, {
          runAsUser: "postgres",
          stdin: sql,
        })
      : {
          command: dbStdinShellCommand(
            place.serviceType,
            place.serviceName,
            PSQL
          ),
          stdin: sql,
        };
  // executeRemoteCommand redacts `secrets` from what it throws.
  return executeRemoteCommand(sshTarget(place.server), command, {
    timeoutMs: TIMEOUT_MS,
    stdin,
    secrets: place.server.password ? [place.server.password] : [],
    readOnly: opts.readOnly,
  });
}

const SEARCH_PATH = "SET search_path = pg_catalog, pg_temp;";

/** The roles whose comment starts with `<legacy>:`, as one JSON line. */
export function legacyRolesSql(legacyName: string): string {
  return [
    SEARCH_PATH,
    "SELECT coalesce(json_agg(json_build_object('role', rolname, 'comment', c)), '[]')",
    "FROM (SELECT rolname, shobj_description(oid, 'pg_authid') AS c FROM pg_roles) r",
    `WHERE c LIKE ${pgQuoteLiteral(`${legacyName}:%`)};`,
    "",
  ].join("\n");
}

/**
 * Sets the role's comment to `to` while it is exactly `from`; a role already
 * carrying `to` is left alone, any other comment (or no such role) refused.
 */
export function remarkRoleSql(role: string, from: string, to: string): string {
  const roleLit = pgQuoteLiteral(role);
  const toLit = pgQuoteLiteral(to);
  const body = [
    "DECLARE c text;",
    "BEGIN",
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleLit}) THEN`,
    `    RAISE EXCEPTION 'role % not found', ${roleLit};`,
    "  END IF;",
    `  SELECT shobj_description(oid, 'pg_authid') INTO c FROM pg_roles WHERE rolname = ${roleLit};`,
    `  IF c IS NOT DISTINCT FROM ${toLit} THEN RETURN; END IF;`,
    `  IF c IS DISTINCT FROM ${pgQuoteLiteral(from)} THEN`,
    `    RAISE EXCEPTION 'role % carries another comment', ${roleLit};`,
    "  END IF;",
    `  EXECUTE format('COMMENT ON ROLE %I IS %L', ${roleLit}, ${toLit});`,
    "END",
  ].join("\n");
  return [SEARCH_PATH, `DO ${pgQuoteLiteral(body)};`, ""].join("\n");
}

function parseRoles(stdout: string): { role: string; comment: string }[] {
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  if (!Array.isArray(parsed)) throw new Error("unexpected role list");
  return parsed.filter(
    (r): r is { role: string; comment: string } =>
      typeof r?.role === "string" && typeof r?.comment === "string"
  );
}

export async function plan(ctx: RemarkContext): Promise<RemarkItem[]> {
  const ours = new Set(
    (await ctx.db.select({ id: environments.id }).from(environments)).map((e) =>
      e.id.toLowerCase()
    )
  );
  const marker = new RegExp(`^${ctx.legacy.name}:(${UUID})$`, "i");
  const items: RemarkItem[] = [];
  for (const place of await pgPlaces(ctx)) {
    let roles: { role: string; comment: string }[];
    try {
      roles = parseRoles(
        await runPg(place, legacyRolesSql(ctx.legacy.name), {
          // A dry run writes nothing, not even to Menara's own database.
          readOnly: true,
        })
      );
    } catch (error) {
      ctx.log.error(place.ref, messageOf(error));
      continue;
    }
    for (const { role, comment } of roles) {
      const envId = marker.exec(comment)?.[1]?.toLowerCase();
      if (!envId || !ours.has(envId)) continue;
      items.push({
        step: "db-markers",
        target: `${place.ref}/roles/${role}`,
        from: comment,
        to: provisionedRoleMarker(envId),
      });
    }
  }
  return items;
}

export async function apply(
  ctx: RemarkContext,
  item: RemarkItem
): Promise<void> {
  const match =
    /^((?:database-hosts|services)\/[0-9a-f-]+)\/roles\/(.+)$/i.exec(
      item.target
    );
  const ref = match?.[1];
  const role = match?.[2];
  if (!ref || !role) throw new Error(`not a db-markers target: ${item.target}`);
  const envId = new RegExp(`^${ctx.legacy.name}:(${UUID})$`, "i")
    .exec(item.from)?.[1]
    ?.toLowerCase();
  if (!envId || item.to !== provisionedRoleMarker(envId)) {
    throw new Error("the item's markers are not this instance's");
  }
  const place = (await pgPlaces(ctx)).find((p) => p.ref === ref);
  if (!place) throw new Error(`${ref} is no longer registered`);
  await runPg(place, remarkRoleSql(role, item.from, item.to), {
    readOnly: false,
  });
}
