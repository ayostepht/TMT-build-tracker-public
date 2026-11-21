ALTER TABLE "build_parts" ADD COLUMN "printing_comps" jsonb;--> statement-breakpoint
ALTER TABLE "print_runs" ADD COLUMN "comps" jsonb;--> statement-breakpoint
ALTER TABLE "printer_jobs" ADD COLUMN "comps" jsonb;