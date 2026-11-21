import { and, eq } from "drizzle-orm";
import {
  AssistantDbLoginMissing,
  assistantDbLoginName,
  enableAssistantDbLogin,
  renameAssistantDbLogin,
} from "@/lib/assistant-db/provision";
import { environmentServices } from "@/lib/db/schema";
import { loadEnvironmentWithServers } from "@/lib/environments";
import type { RemarkContext, RemarkItem } from "@/lib/remark/types";
import { messageOf } from "@/lib/remark/types";
import { encryptNullable } from "@/lib/secrets";
import { findService } from "@/lib/services";
import { tearingDownIn } from "@/lib/teardown/guard";

// Step assistant-logins: the Assistant's read-only login still named
// `<legacy>_ro_…` is renamed on its database server to the name Menara
// derives today (assistantDbLoginName), and environment_services records the
// new name. A login whose access is on is then proven through the enable
// path with its stored password as the environment's own login, which also
// sets that password again: an MD5 secret Postgres clears on rename, or a
// login recorded without one, comes back working (a generated password is
// stored encrypted, as enabling does).

const targetOf = (serviceId: string) => `services/${serviceId}`;

function serviceIdOf(target: string): string {
  const match = /^services\/([0-9a-f-]+)$/i.exec(target);
  if (!match?.[1]) throw new Error(`not an assistant-logins target: ${target}`);
  return match[1];
}

export async function plan(ctx: RemarkContext): Promise<RemarkItem[]> {
  const prefix = `${ctx.legacy.name}_ro_`;
  const rows = await ctx.db.select().from(environmentServices);
  return rows.flatMap((s) =>
    s.role === "db" &&
    s.dbType &&
    s.dbName &&
    s.assistantDbLogin?.startsWith(prefix)
      ? [
          {
            step: "assistant-logins" as const,
            target: targetOf(s.id),
            from: s.assistantDbLogin,
            to: assistantDbLoginName(s.dbType, s.dbName),
          },
        ]
      : []
  );
}

export async function apply(
  ctx: RemarkContext,
  item: RemarkItem
): Promise<void> {
  const serviceId = serviceIdOf(item.target);
  const row = eq(environmentServices.id, serviceId);
  // Under the row lock and the environment's shared lock, as enabling: no
  // toggle of the access and no teardown runs meanwhile. The verification
  // error is thrown after the commit, so the rename stays recorded.
  const failure = await ctx.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        environmentId: environmentServices.environmentId,
        login: environmentServices.assistantDbLogin,
        enabled: environmentServices.assistantDbEnabled,
      })
      .from(environmentServices)
      .where(row)
      .for("update");
    if (!locked) throw new Error("the database service is gone");
    if (locked.login === item.to) return null;
    if (locked.login !== item.from) {
      throw new Error("the recorded login changed since the plan");
    }
    if (await tearingDownIn(tx, locked.environmentId)) {
      throw new Error("the environment is being torn down");
    }
    const environment = await loadEnvironmentWithServers(locked.environmentId);
    const service = environment ? findService(environment, "db") : undefined;
    if (!service?.dbType || !service.dbName || service.id !== serviceId) {
      throw new Error("the database service is gone");
    }
    if (assistantDbLoginName(service.dbType, service.dbName) !== item.to) {
      throw new Error("the new login name no longer matches the database");
    }
    try {
      await renameAssistantDbLogin(service, {
        environmentId: locked.environmentId,
        from: item.from,
        to: item.to,
      });
    } catch (error) {
      // Access off and no login under either name: a disable dropped it but
      // could not forget it. Nothing to rename; the row takes the new name
      // (a later disable of `to` finds it gone and forgets it), so the item
      // is done instead of failing every run.
      if (!(error instanceof AssistantDbLoginMissing && !locked.enabled)) {
        throw error;
      }
    }
    await tx
      .update(environmentServices)
      .set({ assistantDbLogin: item.to })
      .where(and(row, eq(environmentServices.assistantDbLogin, item.from)));
    if (!locked.enabled) return null;
    try {
      const proven = await enableAssistantDbLogin(service, {
        environmentId: locked.environmentId,
        ownLogin: item.to,
        password: service.assistantDbPassword,
      });
      if (proven.password !== service.assistantDbPassword) {
        await tx
          .update(environmentServices)
          .set({ assistantDbPassword: encryptNullable(proven.password) })
          .where(and(row, eq(environmentServices.assistantDbLogin, item.to)));
      }
      return null;
    } catch (error) {
      return `renamed, but the login cannot log in: ${messageOf(error)}; turn the Assistant's database access off and on for ${environment?.name ?? locked.environmentId} to reset the login`;
    }
  });
  if (failure) throw new Error(failure);
}
