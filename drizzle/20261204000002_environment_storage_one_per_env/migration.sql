SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "environment_storage" (
	"environment_id" uuid PRIMARY KEY,
	"endpoint" text NOT NULL,
	"region" text DEFAULT 'us-east-1' NOT NULL,
	"bucket" text NOT NULL,
	"key_prefix" text,
	"access_key_id" text NOT NULL,
	"secret_key" text NOT NULL,
	"force_path_style" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "environment_storage_key_prefix_check" CHECK ("key_prefix" IS NULL OR ("key_prefix" <> '' AND left("key_prefix", 1) <> '/' AND right("key_prefix", 1) = '/'))
);
--> statement-breakpoint
ALTER TABLE "environment_storage" ADD CONSTRAINT "environment_storage_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Backfill: copy each environment's owned connection into its one storage row.
-- An environment with several connections keeps the most recently updated one
-- (id desc breaks ties), the others stay in s3_connections until the contract
-- release. The legacy backup-destination connection is never copied (its
-- protection is id-based and would be lost). Secrets are copied as stored.
INSERT INTO "environment_storage" ("environment_id", "endpoint", "region", "bucket", "key_prefix", "access_key_id", "secret_key", "force_path_style", "created_at", "updated_at")
SELECT DISTINCT ON (c."environment_id") c."environment_id", c."endpoint", c."region", c."bucket", c."key_prefix", c."access_key_id", c."secret_key", c."force_path_style", c."created_at", c."updated_at"
FROM "s3_connections" c
WHERE c."environment_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "instance_settings" s WHERE s."backup_destination_id" = c."id")
ORDER BY c."environment_id", c."updated_at" DESC, c."id" DESC
ON CONFLICT ("environment_id") DO NOTHING;--> statement-breakpoint
-- Unassigned connections are admin-only and the admin page that managed them
-- is gone: delete those nothing references (no archive, not the backup destination).
DELETE FROM "s3_connections" c
WHERE c."environment_id" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "environment_archives" a WHERE a."s3_connection_id" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "instance_settings" s WHERE s."backup_destination_id" = c."id");
