SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "app_components" ALTER COLUMN "notify_secret_name" SET DEFAULT 'menara_notify';
