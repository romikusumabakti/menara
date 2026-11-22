import "reflect-metadata";
import { mkdirSync, writeFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { avatarUrl } from "@/lib/avatar-url";
import { AVATAR_HASH, CREDENTIALS, PROFILE } from "./paths";

/**
 * Prepares the screenshot database after e2e/reset-db.ts has migrated it:
 * the demo data (`menara seed demo`), then demo-admin dressed as the
 * maintainer (name, preferred name, email, avatar from avatar.jpg via the spec's route stub,
 * the amber accent of the logo) with some work on their plate: assigned
 * issues, recently opened environments, a successful backup. The Assistant is
 * switched on with a placeholder key so its pages render; no model is ever
 * called (the spec only opens chats the seed stored, and the base URL points
 * at a closed loopback port).
 *
 * Run from playwright.screenshots.config.ts's `webServer.command`, before the
 * server starts, with `--no-env-file`.
 */
const [{ db, pgClient }, { auth }, { encryptSecret }, { seedDemo }, schema] =
  await Promise.all([
    import("@/lib/db"),
    import("@/lib/auth"),
    import("@/lib/secrets"),
    import("@/scripts/cli/seed"),
    import("@/lib/db/schema"),
  ]);

const lines: string[] = [];
try {
  const context = await auth.$context;
  await seedDemo(db as unknown as PostgresJsDatabase, {
    printPasswords: true,
    // The e2e server runs with NODE_ENV=production; reset-db.ts has already
    // refused anything but a loopback *_e2e database.
    force: true,
    nodeEnv: process.env.NODE_ENV,
    hashPassword: context.password.hash,
    encryptSecret,
    out: (line) => lines.push(line),
  });
  const admin = lines
    .map((l) => l.match(/^created (demo-admin@\S+) \(admin\) password: (\S+)$/))
    .find(Boolean);
  if (!admin?.[1] || !admin[2]) {
    throw new Error("The seed did not create demo-admin on a fresh database");
  }
  const [user] = await db
    .update(schema.users)
    .set({
      name: PROFILE.name,
      preferredName: PROFILE.preferredName,
      email: PROFILE.email,
      accentColor: "amber",
      avatarSource: "upload",
    })
    .where(eq(schema.users.email, admin[1]))
    .returning({ id: schema.users.id });
  if (!user) throw new Error("demo-admin vanished");
  await db
    .update(schema.users)
    .set({ image: avatarUrl(user.id, AVATAR_HASH) })
    .where(eq(schema.users.id, user.id));
  mkdirSync("e2e/.auth", { recursive: true });
  writeFileSync(
    CREDENTIALS,
    JSON.stringify({ email: PROFILE.email, password: admin[2] }),
    { mode: 0o600 }
  );

  // Five open issues on their plate.
  const open = await db
    .select({ id: schema.issues.id })
    .from(schema.issues)
    .where(inArray(schema.issues.status, ["open", "in_progress"]))
    .orderBy(schema.issues.number)
    .limit(5);
  await db
    .update(schema.issues)
    .set({ assigneeId: user.id })
    .where(
      inArray(
        schema.issues.id,
        open.map((i) => i.id)
      )
    );

  // Environments opened lately (Home's "Jump back in"), most recent first.
  const opened = [
    ["DEMO", "qa"],
    ["DEMOPORTAL", "dev"],
    ["NPCP", "qa"],
    ["BSAC", "demo"],
  ];
  const envs = await db
    .select({
      id: schema.environments.id,
      slug: schema.environments.slug,
      key: schema.projects.key,
    })
    .from(schema.environments)
    .innerJoin(
      schema.projects,
      eq(schema.projects.id, schema.environments.projectId)
    );
  const recent = opened.flatMap(
    ([key, slug]) => envs.find((e) => e.key === key && e.slug === slug) ?? []
  );
  const now = Date.now();
  await db.insert(schema.environmentAccess).values(
    recent.map((env, i) => ({
      userId: user.id,
      environmentId: env.id,
      lastAccessedAt: new Date(now - (i + 1) * 47 * 60_000),
    }))
  );

  // Last night's scheduled backup, so Home does not flag a missing one.
  const backupAt = new Date(now - 9 * 60 * 60_000);
  await db.insert(schema.instanceBackups).values({
    startedAt: backupAt,
    finishedAt: new Date(backupAt.getTime() + 95_000),
    status: "succeeded",
    trigger: "schedule",
    version: "0.8.0",
    location: "local",
    objectKey: "instance-backups/screenshots.tar.zst",
    sizeBytes: 48_213_504,
  });

  const assistant = {
    assistantEnabled: true,
    assistantProvider: "openai-compatible" as const,
    assistantBaseUrl: "http://127.0.0.1:9/v1",
    assistantModel: "demo-model",
    assistantApiKey: encryptSecret("screenshots-placeholder-key"),
  };
  await db
    .insert(schema.instanceSettings)
    .values({ id: 1, ...assistant })
    .onConflictDoUpdate({ target: schema.instanceSettings.id, set: assistant });
  console.log("screenshot data ready");
} finally {
  await pgClient().end();
}
