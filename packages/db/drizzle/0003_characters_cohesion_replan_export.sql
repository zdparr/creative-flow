CREATE TABLE "book_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"issues" jsonb NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replan_diffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"after_chapter" integer NOT NULL,
	"items" jsonb NOT NULL,
	"job_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exports" ALTER COLUMN "s3_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chapter_drafts" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "character_versions" ADD COLUMN "source" text DEFAULT 'drafted' NOT NULL;--> statement-breakpoint
ALTER TABLE "cohesion_reports" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "cohesion_reports" ADD COLUMN "paid_promise_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "cohesion_reports" ADD COLUMN "planted_promises" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cohesion_reports" ADD COLUMN "checkpoints_met" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cohesion_reports" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "drift_events" ADD COLUMN "details" jsonb DEFAULT '{"beatId":null,"factId":null,"character":null,"adoptText":""}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "file_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "byte_size" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "content" "bytea";--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "book_reviews" ADD CONSTRAINT "book_reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_reviews" ADD CONSTRAINT "book_reviews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replan_diffs" ADD CONSTRAINT "replan_diffs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replan_diffs" ADD CONSTRAINT "replan_diffs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohesion_reports" ADD CONSTRAINT "cohesion_reports_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;