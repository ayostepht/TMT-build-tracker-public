CREATE TABLE "build_custom_pieces" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"name" text NOT NULL,
	"file_name" text,
	"sliced" boolean DEFAULT false NOT NULL,
	"replaces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"library_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_custom_pieces" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"file_name" text,
	"sliced" boolean DEFAULT false NOT NULL,
	"template_id" text,
	"replaces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "build_parts" ADD COLUMN "skipped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "build_custom_pieces" ADD CONSTRAINT "build_custom_pieces_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_custom_pieces" ADD CONSTRAINT "build_custom_pieces_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_custom_pieces" ADD CONSTRAINT "workspace_custom_pieces_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_custom_pieces" ADD CONSTRAINT "workspace_custom_pieces_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_custom_pieces_build_idx" ON "build_custom_pieces" USING btree ("build_id");--> statement-breakpoint
CREATE INDEX "workspace_custom_pieces_org_idx" ON "workspace_custom_pieces" USING btree ("organization_id");