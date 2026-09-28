ALTER TABLE "jobs" DROP CONSTRAINT "jobs_queue_job_id_unique";--> statement-breakpoint
ALTER TABLE "outline_chapters" ADD COLUMN "promises" jsonb DEFAULT '{"planted":[],"paid":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "queue_job_id";