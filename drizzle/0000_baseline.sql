CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp with time zone NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "build_assembly" (
	"build_id" text NOT NULL,
	"item_key" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"done_by" text,
	"done_at" timestamp with time zone,
	CONSTRAINT "build_assembly_build_id_item_key_pk" PRIMARY KEY("build_id","item_key")
);
--> statement-breakpoint
CREATE TABLE "build_filaments" (
	"build_id" text NOT NULL,
	"role_key" text NOT NULL,
	"name" text NOT NULL,
	"material" text NOT NULL,
	"hex" text NOT NULL,
	"spools" double precision DEFAULT 0 NOT NULL,
	"spool_adds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "build_filaments_build_id_role_key_pk" PRIMARY KEY("build_id","role_key")
);
--> statement-breakpoint
CREATE TABLE "build_handoff" (
	"build_id" text PRIMARY KEY NOT NULL,
	"recipient_name" text,
	"organization" text,
	"contact" text,
	"handed_off_on" text,
	"location" text,
	"notes" text DEFAULT '' NOT NULL,
	"safety_checked" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "build_part_profiles" (
	"build_id" text NOT NULL,
	"part_slug" text NOT NULL,
	"seconds_per_copy" double precision,
	"grams_by_role" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"method" text DEFAULT 'volume-split' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "build_part_profiles_build_id_part_slug_pk" PRIMARY KEY("build_id","part_slug")
);
--> statement-breakpoint
CREATE TABLE "build_parts" (
	"build_id" text NOT NULL,
	"part_slug" text NOT NULL,
	"status" text DEFAULT 'To print' NOT NULL,
	"started_at" timestamp with time zone,
	"printed_on" text,
	"run_est_seconds" integer,
	"comps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assignee_user_id" text,
	"manual_grams" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "build_parts_build_id_part_slug_pk" PRIMARY KEY("build_id","part_slug")
);
--> statement-breakpoint
CREATE TABLE "build_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"kind" text DEFAULT 'progress' NOT NULL,
	"path" text NOT NULL,
	"thumb_path" text,
	"caption" text DEFAULT '' NOT NULL,
	"width" integer,
	"height" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "build_plates" (
	"build_id" text NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"est_seconds" integer,
	"runs" integer DEFAULT 1 NOT NULL,
	"per_part_runs" boolean DEFAULT false NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"slicer_grams" double precision,
	"slicer_grams_source" text,
	"manual_est_seconds" integer,
	"manual_est_source" text,
	"slicer_by_part" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"thumbnail_path" text,
	"filament_grams" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"arrangement" jsonb,
	"source" text DEFAULT 'template' NOT NULL,
	CONSTRAINT "build_plates_build_id_number_pk" PRIMARY KEY("build_id","number")
);
--> statement-breakpoint
CREATE TABLE "build_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"kind" text DEFAULT '3mf' NOT NULL,
	"file_name" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'parsed' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"template_id" text NOT NULL,
	"name" text NOT NULL,
	"recipient" text,
	"hospital" text,
	"phase" text DEFAULT 'design' NOT NULL,
	"delivery_date" text,
	"design" jsonb,
	"variant_choices" jsonb,
	"plate_layout" text,
	"printer" jsonb,
	"setup_step" integer,
	"kind" text DEFAULT 'build' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "color_designs" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"author_user_id" text,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"part_roles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"shared_at" timestamp with time zone,
	"shared_by" text,
	"copied_from_design_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "color_designs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "custom_filaments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"brand" text NOT NULL,
	"material" text NOT NULL,
	"color_name" text NOT NULL,
	"hex" text NOT NULL,
	"finish" text,
	"hardness" text,
	"url" text,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "print_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"plate_number" integer,
	"part_slug" text,
	"part_slugs" jsonb,
	"date" text NOT NULL,
	"result" text NOT NULL,
	"grams" double precision,
	"hours" double precision,
	"est_seconds" integer,
	"printer" text,
	"user_id" text,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "printer_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"printer_id" text NOT NULL,
	"build_id" text,
	"plate_number" integer,
	"part_slugs" jsonb,
	"file_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'printing' NOT NULL,
	"progress" double precision,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "printers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"host" text NOT NULL,
	"port" integer,
	"catalog_id" text,
	"secret_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"camera_url" text,
	"camera_enabled" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_status" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_admin" (
	"user_id" text PRIMARY KEY NOT NULL,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_assembly_steps" (
	"template_id" text NOT NULL,
	"key" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"guide_page" integer,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hardware" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"when" jsonb,
	CONSTRAINT "template_assembly_steps_template_id_key_pk" PRIMARY KEY("template_id","key")
);
--> statement-breakpoint
CREATE TABLE "template_filament_roles" (
	"template_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"material" text NOT NULL,
	"hex" text NOT NULL,
	"tpu" boolean DEFAULT false NOT NULL,
	"recommended_spools" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "template_filament_roles_template_id_key_pk" PRIMARY KEY("template_id","key")
);
--> statement-breakpoint
CREATE TABLE "template_guide_pages" (
	"template_id" text NOT NULL,
	"page" integer NOT NULL,
	"title" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"image_path" text,
	CONSTRAINT "template_guide_pages_template_id_page_pk" PRIMARY KEY("template_id","page")
);
--> statement-breakpoint
CREATE TABLE "template_hardware" (
	"template_id" text NOT NULL,
	"name" text NOT NULL,
	"qty" integer,
	"note" text,
	CONSTRAINT "template_hardware_template_id_name_pk" PRIMARY KEY("template_id","name")
);
--> statement-breakpoint
CREATE TABLE "template_model_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"input_path" text NOT NULL,
	"report" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "template_models" (
	"template_id" text PRIMARY KEY NOT NULL,
	"glb_path" text NOT NULL,
	"version" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"slugs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_part_placements" (
	"template_id" text NOT NULL,
	"slug" text NOT NULL,
	"matrix" jsonb NOT NULL,
	"instances" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"placed" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_part_placements_template_id_slug_pk" PRIMARY KEY("template_id","slug")
);
--> statement-breakpoint
CREATE TABLE "template_parts" (
	"template_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"section" text NOT NULL,
	"default_role" text NOT NULL,
	"bom_grams" double precision,
	"qty" integer,
	"walls" integer,
	"infill" text DEFAULT '' NOT NULL,
	"supports" text DEFAULT '' NOT NULL,
	"brim" text,
	"source_file" text DEFAULT '' NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_materials" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"symmetry_group" text,
	"guide_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "template_parts_template_id_slug_pk" PRIMARY KEY("template_id","slug")
);
--> statement-breakpoint
CREATE TABLE "template_plate_layouts" (
	"template_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"printer_note" text DEFAULT '' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"plates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "template_plate_layouts_template_id_key_pk" PRIMARY KEY("template_id","key")
);
--> statement-breakpoint
CREATE TABLE "template_plates" (
	"template_id" text NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"est_seconds" integer,
	"runs" integer DEFAULT 1 NOT NULL,
	"run_note" text,
	"per_part_runs" boolean DEFAULT false NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "template_plates_template_id_number_pk" PRIMARY KEY("template_id","number")
);
--> statement-breakpoint
CREATE TABLE "template_print_geometry" (
	"template_id" text NOT NULL,
	"slug" text NOT NULL,
	"footprint" jsonb NOT NULL,
	"hull" jsonb NOT NULL,
	"height" double precision NOT NULL,
	"tris" integer DEFAULT 0 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mesh_path" text NOT NULL,
	"source_note" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_print_geometry_template_id_slug_pk" PRIMARY KEY("template_id","slug")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source_url" text,
	"global_settings" text DEFAULT '' NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variant_groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owner_org_id" text,
	"base_template_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_assembly" ADD CONSTRAINT "build_assembly_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_assembly" ADD CONSTRAINT "build_assembly_done_by_user_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_filaments" ADD CONSTRAINT "build_filaments_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_handoff" ADD CONSTRAINT "build_handoff_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_handoff" ADD CONSTRAINT "build_handoff_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_part_profiles" ADD CONSTRAINT "build_part_profiles_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_parts" ADD CONSTRAINT "build_parts_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_parts" ADD CONSTRAINT "build_parts_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_photos" ADD CONSTRAINT "build_photos_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_photos" ADD CONSTRAINT "build_photos_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_plates" ADD CONSTRAINT "build_plates_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_uploads" ADD CONSTRAINT "build_uploads_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_uploads" ADD CONSTRAINT "build_uploads_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "color_designs" ADD CONSTRAINT "color_designs_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "color_designs" ADD CONSTRAINT "color_designs_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "color_designs" ADD CONSTRAINT "color_designs_shared_by_user_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "color_designs" ADD CONSTRAINT "color_designs_copied_from_design_id_color_designs_id_fk" FOREIGN KEY ("copied_from_design_id") REFERENCES "public"."color_designs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_filaments" ADD CONSTRAINT "custom_filaments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_filaments" ADD CONSTRAINT "custom_filaments_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_runs" ADD CONSTRAINT "print_runs_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_runs" ADD CONSTRAINT "print_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printer_jobs" ADD CONSTRAINT "printer_jobs_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printer_jobs" ADD CONSTRAINT "printer_jobs_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_admin" ADD CONSTRAINT "site_admin_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_admin" ADD CONSTRAINT "site_admin_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_assembly_steps" ADD CONSTRAINT "template_assembly_steps_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_filament_roles" ADD CONSTRAINT "template_filament_roles_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_guide_pages" ADD CONSTRAINT "template_guide_pages_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_hardware" ADD CONSTRAINT "template_hardware_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_model_jobs" ADD CONSTRAINT "template_model_jobs_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_model_jobs" ADD CONSTRAINT "template_model_jobs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_models" ADD CONSTRAINT "template_models_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_models" ADD CONSTRAINT "template_models_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_part_placements" ADD CONSTRAINT "template_part_placements_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_part_placements" ADD CONSTRAINT "template_part_placements_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_parts" ADD CONSTRAINT "template_parts_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_plate_layouts" ADD CONSTRAINT "template_plate_layouts_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_plates" ADD CONSTRAINT "template_plates_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_print_geometry" ADD CONSTRAINT "template_print_geometry_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_owner_org_id_organization_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "activity_build_idx" ON "activity" USING btree ("build_id","at");--> statement-breakpoint
CREATE INDEX "build_photos_build_idx" ON "build_photos" USING btree ("build_id","created_at");--> statement-breakpoint
CREATE INDEX "build_uploads_build_idx" ON "build_uploads" USING btree ("build_id","created_at");--> statement-breakpoint
CREATE INDEX "builds_org_idx" ON "builds" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "builds_template_idx" ON "builds" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "color_designs_template_idx" ON "color_designs" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "color_designs_shared_at_idx" ON "color_designs" USING btree ("shared_at");--> statement-breakpoint
CREATE INDEX "custom_filaments_org_idx" ON "custom_filaments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "print_runs_build_idx" ON "print_runs" USING btree ("build_id");--> statement-breakpoint
CREATE INDEX "printer_jobs_printer_idx" ON "printer_jobs" USING btree ("printer_id","started_at");--> statement-breakpoint
CREATE INDEX "printers_org_idx" ON "printers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "template_model_jobs_template_idx" ON "template_model_jobs" USING btree ("template_id","created_at");--> statement-breakpoint
CREATE INDEX "templates_owner_org_idx" ON "templates" USING btree ("owner_org_id");