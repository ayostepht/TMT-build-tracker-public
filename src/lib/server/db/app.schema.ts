import { sql } from 'drizzle-orm';
import {
	type AnyPgColumn,
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp
} from 'drizzle-orm/pg-core';
import type { ArrangedPlate } from '#lib/domain/arrange.ts';
import type { BuildPrinter, VariantGroup } from '#lib/domain/types.ts';
import { organization, user } from './auth.schema';

const TS = { withTimezone: true, mode: 'date' } as const;

const id = () =>
	text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at', TS).notNull().defaultNow();

// ---- Templates (printable kits). Data only: no vendor models, images or files.

export const templates = pgTable(
	'templates',
	{
		id: id(),
		slug: text('slug').notNull().unique(),
		name: text('name').notNull(),
		version: text('version').notNull(),
		description: text('description').notNull().default(''),
		sourceUrl: text('source_url'),
		globalSettings: text('global_settings').notNull().default(''),
		sections: jsonb('sections')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		variantGroups: jsonb('variant_groups')
			.$type<VariantGroup[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** Workspace that owns this copy (a fork made from the user's own files); null = global, shown to everyone. */
		ownerOrgId: text('owner_org_id').references(() => organization.id, { onDelete: 'cascade' }),
		/** The global template this fork was copied from. */
		baseTemplateId: text('base_template_id'),
		createdAt: createdAt()
	},
	(t) => [index('templates_owner_org_idx').on(t.ownerOrgId)]
);

const templateId = () =>
	text('template_id')
		.notNull()
		.references(() => templates.id, { onDelete: 'cascade' });

export const templateFilamentRoles = pgTable(
	'template_filament_roles',
	{
		templateId: templateId(),
		key: text('key').notNull(),
		name: text('name').notNull(),
		material: text('material').notNull(),
		hex: text('hex').notNull(),
		tpu: boolean('tpu').notNull().default(false),
		recommendedSpools: integer('recommended_spools').notNull().default(1)
	},
	(t) => [primaryKey({ columns: [t.templateId, t.key] })]
);

export const templateParts = pgTable(
	'template_parts',
	{
		templateId: templateId(),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		section: text('section').notNull(),
		defaultRole: text('default_role').notNull(),
		bomGrams: doublePrecision('bom_grams'),
		qty: integer('qty'),
		walls: integer('walls'),
		infill: text('infill').notNull().default(''),
		supports: text('supports').notNull().default(''),
		brim: text('brim'),
		sourceFile: text('source_file').notNull().default(''),
		notes: jsonb('notes')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		components: jsonb('components')
			.$type<{ name: string; file?: string; settings: string }[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		allowedMaterials: jsonb('allowed_materials')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		symmetryGroup: text('symmetry_group'),
		guideRefs: jsonb('guide_refs')
			.$type<{ page: number; text: string }[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		sort: integer('sort').notNull().default(0)
	},
	(t) => [primaryKey({ columns: [t.templateId, t.slug] })]
);

export const templatePlates = pgTable(
	'template_plates',
	{
		templateId: templateId(),
		number: integer('number').notNull(),
		name: text('name').notNull(),
		estSeconds: integer('est_seconds'),
		runs: integer('runs').notNull().default(1),
		runNote: text('run_note'),
		perPartRuns: boolean('per_part_runs').notNull().default(false),
		parts: jsonb('parts')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`)
	},
	(t) => [primaryKey({ columns: [t.templateId, t.number] })]
);

export const templateGuidePages = pgTable(
	'template_guide_pages',
	{
		templateId: templateId(),
		page: integer('page').notNull(),
		title: text('title').notNull(),
		sort: integer('sort').notNull().default(0),
		/** Rendered page image under the uploads dir (milestone 6); null until a site admin imports the guide. */
		imagePath: text('image_path')
	},
	(t) => [primaryKey({ columns: [t.templateId, t.page] })]
);

/** Assembly checklist steps for a kit (milestone 6). Seeded data; editable by site admins later. */
export const templateAssemblySteps = pgTable(
	'template_assembly_steps',
	{
		templateId: templateId(),
		key: text('key').notNull(),
		sort: integer('sort').notNull().default(0),
		title: text('title').notNull(),
		description: text('description').notNull().default(''),
		guidePage: integer('guide_page'),
		/** Part slugs used in this step (filtered by the build's variant choices). */
		parts: jsonb('parts')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** Kit hardware used: [{ name, qty? }] */
		hardware: jsonb('hardware')
			.$type<{ name: string; qty?: number }[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** Fit tests / checks to tick: [{ key, text }] */
		checks: jsonb('checks')
			.$type<{ key: string; text: string }[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** Only shown when a variant option is chosen: { group, option } */
		when: jsonb('when').$type<{ group: string; option: string }>()
	},
	(t) => [primaryKey({ columns: [t.templateId, t.key] })]
);

export const templateHardware = pgTable(
	'template_hardware',
	{
		templateId: templateId(),
		name: text('name').notNull(),
		qty: integer('qty'),
		note: text('note')
	},
	(t) => [primaryKey({ columns: [t.templateId, t.name] })]
);

export const templatePartPlacements = pgTable(
	'template_part_placements',
	{
		templateId: templateId(),
		slug: text('slug').notNull(),
		/** Column-major 4x4 (three.js order), mm. */
		matrix: jsonb('matrix').$type<number[]>().notNull(),
		/** Extra instances, each a column-major 4x4. */
		instances: jsonb('instances')
			.$type<number[][]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		placed: boolean('placed').notNull().default(false),
		updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
		updatedAt: timestamp('updated_at', TS).notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.templateId, t.slug] })]
);

/** The assembled 3D model of a template, built per install from uploaded STEP files. The GLB lives in the data volume (see uploadsDir()); this row records it. */
export const templateModels = pgTable('template_models', {
	templateId: text('template_id')
		.primaryKey()
		.references(() => templates.id, { onDelete: 'cascade' }),
	glbPath: text('glb_path').notNull(),
	/** Changes on every re-import; part of the model URL for cache busting. */
	version: text('version').notNull(),
	size: integer('size').notNull().default(0),
	/** Part slugs present as nodes in the GLB. */
	slugs: jsonb('slugs')
		.$type<string[]>()
		.notNull()
		.default(sql`'[]'::jsonb`),
	sourceNote: text('source_note').notNull().default(''),
	createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
	createdAt: createdAt()
});

/** Background conversions of an uploaded STEP zip into the template's GLB (milestone 4). */
export const templateModelJobs = pgTable(
	'template_model_jobs',
	{
		id: id(),
		templateId: templateId(),
		status: text('status').notNull().default('queued'), // queued | running | done | failed
		progress: integer('progress').notNull().default(0), // 0-100
		message: text('message').notNull().default(''),
		/** Uploaded file under the uploads dir; deleted after the job unless kept for debugging. */
		inputPath: text('input_path').notNull(),
		/** Per-file results: { file, slug | null, status, triangles?, ms?, error? }[] */
		report: jsonb('report')
			.$type<Record<string, unknown>[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		createdAt: createdAt(),
		finishedAt: timestamp('finished_at', TS)
	},
	(t) => [index('template_model_jobs_template_idx').on(t.templateId, t.createdAt)]
);

/**
 * Built-in plate layouts per printer family (milestone 5), e.g. 'xpa' (Bambu
 * X1/P1/A1, 24 plates) and 'h2d' (Bambu H2D/H2S, 21 plates). Data only: plate
 * names, part slugs, runs and estimates; no slicer files. `template_plates`
 * stays the default layout for existing code.
 */
export const templatePlateLayouts = pgTable(
	'template_plate_layouts',
	{
		templateId: templateId(),
		key: text('key').notNull(),
		name: text('name').notNull(),
		printerNote: text('printer_note').notNull().default(''),
		isDefault: boolean('is_default').notNull().default(false),
		plates: jsonb('plates')
			.$type<
				{
					number: number;
					name: string;
					estSeconds: number | null;
					runs: number;
					runNote?: string;
					perPartRuns?: boolean;
					parts: string[];
				}[]
			>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		sort: integer('sort').notNull().default(0)
	},
	(t) => [primaryKey({ columns: [t.templateId, t.key] })]
);

// ---- Color designs

export const colorDesigns = pgTable(
	'color_designs',
	{
		id: id(),
		templateId: templateId(),
		slug: text('slug').notNull().unique(),
		name: text('name').notNull(),
		authorUserId: text('author_user_id').references(() => user.id, { onDelete: 'set null' }),
		roles: jsonb('roles')
			.$type<{ key: string; name: string; material: string; hex: string }[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		partRoles: jsonb('part_roles')
			.$type<Record<string, string>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		isPublic: boolean('is_public').notNull().default(false),
		/** Shared to the site-wide gallery at this time; null = not shared. */
		sharedAt: timestamp('shared_at', TS),
		sharedBy: text('shared_by').references(() => user.id, { onDelete: 'set null' }),
		/** Provenance when this design was copied from the gallery (or another team's design). */
		copiedFromDesignId: text('copied_from_design_id').references(
			(): AnyPgColumn => colorDesigns.id,
			{ onDelete: 'set null' }
		),
		createdAt: createdAt()
	},
	(t) => [
		index('color_designs_template_idx').on(t.templateId),
		index('color_designs_shared_at_idx').on(t.sharedAt)
	]
);

// ---- Builds

export const builds = pgTable(
	'builds',
	{
		id: id(),
		organizationId: text('organization_id')
			.notNull()
			.references(() => organization.id, { onDelete: 'cascade' }),
		templateId: text('template_id')
			.notNull()
			.references(() => templates.id),
		name: text('name').notNull(),
		recipient: text('recipient'),
		hospital: text('hospital'),
		phase: text('phase').notNull().default('design'),
		deliveryDate: text('delivery_date'),
		design: jsonb('design').$type<Record<string, unknown>>(),
		/** group key → option key; null on builds from before variants (= template defaults). */
		variantChoices: jsonb('variant_choices').$type<Record<string, string>>(),
		/** Plate layout source: a template_plate_layouts key, or 'upload' when plates came from the build's own 3MF. Null = template default. */
		plateLayout: text('plate_layout'),
		/** Printer the build is planned for (BuildPrinter json); null = not chosen. */
		printer: jsonb('printer').$type<BuildPrinter>(),
		/** Setup wizard: the step (1-5) the build is on; null = setup finished (or never started, for older builds). */
		setupStep: integer('setup_step'),
		/** 'build' (tracked build) | 'draft' (Design studio sandbox: no tracking; hidden from build lists). */
		kind: text('kind').notNull().default('build'),
		createdBy: text('created_by')
			.notNull()
			.references(() => user.id),
		createdAt: createdAt()
	},
	(t) => [
		index('builds_org_idx').on(t.organizationId),
		index('builds_template_idx').on(t.templateId)
	]
);

const buildId = () =>
	text('build_id')
		.notNull()
		.references(() => builds.id, { onDelete: 'cascade' });

/** One "added a spool" entry on a build filament slot (kg, ms timestamp). */
export type SpoolAdd = {
	id: string;
	kg: number;
	at: number;
	userId: string | null;
	note?: string;
};

export const buildFilaments = pgTable(
	'build_filaments',
	{
		buildId: buildId(),
		roleKey: text('role_key').notNull(),
		name: text('name').notNull(),
		material: text('material').notNull(),
		hex: text('hex').notNull(),
		spools: doublePrecision('spools').notNull().default(0),
		/** Spools added after the start (kg each); total stock = spools + sum of these. */
		spoolAdds: jsonb('spool_adds')
			.$type<SpoolAdd[]>()
			.notNull()
			.default(sql`'[]'::jsonb`)
	},
	(t) => [primaryKey({ columns: [t.buildId, t.roleKey] })]
);

export const buildParts = pgTable(
	'build_parts',
	{
		buildId: buildId(),
		partSlug: text('part_slug').notNull(),
		status: text('status').notNull().default('To print'),
		startedAt: timestamp('started_at', TS),
		printedOn: text('printed_on'),
		runEstSeconds: integer('run_est_seconds'),
		comps: jsonb('comps')
			.$type<Record<string, boolean>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		assigneeUserId: text('assignee_user_id').references(() => user.id, { onDelete: 'set null' }),
		/** Grams the maker typed for the whole part (all copies). Null = none entered. */
		manualGrams: doublePrecision('manual_grams'),
		updatedAt: timestamp('updated_at', TS).notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.buildId, t.partSlug] })]
);

export const buildPlates = pgTable(
	'build_plates',
	{
		buildId: buildId(),
		number: integer('number').notNull(),
		name: text('name').notNull(),
		estSeconds: integer('est_seconds'),
		runs: integer('runs').notNull().default(1),
		perPartRuns: boolean('per_part_runs').notNull().default(false),
		parts: jsonb('parts')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		slicerGrams: doublePrecision('slicer_grams'),
		/** Where slicerGrams / slicerByPart came from: 'user' (typed), 'file' (sliced 3MF), 'printer'. Null = older row; the reader infers it. */
		slicerGramsSource: text('slicer_grams_source').$type<'user' | 'file' | 'printer'>(),
		/** Time typed in by hand (seconds per run); overrides the file's and every estimated time. */
		manualEstSeconds: integer('manual_est_seconds'),
		/** Who set the manual time: 'user' (typed) or 'printer' (from a linked printer job; a typed one is never overwritten by it). */
		manualEstSource: text('manual_est_source').$type<'user' | 'printer'>(),
		slicerByPart: jsonb('slicer_by_part')
			.$type<Record<string, number>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		thumbnailPath: text('thumbnail_path'),
		/** Grams per run by build filament role key, from a sliced 3MF (milestone 5). */
		filamentGrams: jsonb('filament_grams')
			.$type<Record<string, number>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		/** Arranged plates (source 'arranged'): item positions in mm, see domain/arrange.ts ArrangedPlate. Null otherwise. */
		arrangement: jsonb('arrangement').$type<ArrangedPlate>(),
		/** 'template' | 'layout:<key>' | 'upload:<build_uploads.id>' */
		source: text('source').notNull().default('template')
	},
	(t) => [primaryKey({ columns: [t.buildId, t.number] })]
);

export const printRuns = pgTable(
	'print_runs',
	{
		id: id(),
		buildId: buildId(),
		plateNumber: integer('plate_number'),
		partSlug: text('part_slug'),
		partSlugs: jsonb('part_slugs').$type<string[]>(),
		date: text('date').notNull(),
		result: text('result').notNull(),
		grams: doublePrecision('grams'),
		hours: doublePrecision('hours'),
		/** The run's own planned time (seconds) when it was logged, from the parts' run time; pace compares against it. */
		estSeconds: integer('est_seconds'),
		printer: text('printer'),
		userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
		note: text('note').notNull().default(''),
		/** Exact creation time (set on insert). */
		createdAt: timestamp('created_at', TS).notNull().defaultNow()
	},
	(t) => [index('print_runs_build_idx').on(t.buildId)]
);

export const activity = pgTable(
	'activity',
	{
		id: id(),
		buildId: buildId(),
		userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
		kind: text('kind').notNull(),
		payload: jsonb('payload')
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		at: timestamp('at', TS).notNull().defaultNow()
	},
	(t) => [index('activity_build_idx').on(t.buildId, t.at)]
);

/** Slicer files uploaded to a build (milestone 5). The original file is not kept; only the parsed summary and thumbnails. */
export const buildUploads = pgTable(
	'build_uploads',
	{
		id: id(),
		buildId: buildId(),
		kind: text('kind').notNull().default('3mf'),
		fileName: text('file_name').notNull(),
		size: integer('size').notNull().default(0),
		/** Parsed, normalised 3MF summary (printer, filaments, plates, objects) plus the user's object → part mapping. */
		summary: jsonb('summary')
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		status: text('status').notNull().default('parsed'), // parsed | applied | discarded
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		createdAt: createdAt()
	},
	(t) => [index('build_uploads_build_idx').on(t.buildId, t.createdAt)]
);

/**
 * Print-orientation geometry of a template's parts, imported by a site admin from the
 * kit author's profile 3MF (numbers in `footprint`/`hull`/`settings`, the mesh in a
 * binary file under uploadsDir()/print/<templateId>/<slug>.bin, never in git).
 * One row per part slug; duplicate objects (16 tires, 8 wheel pins) are one mesh plus
 * `footprint.copies`. Format: src/lib/server/print-geometry/README in `format.ts`.
 */
export const templatePrintGeometry = pgTable(
	'template_print_geometry',
	{
		templateId: templateId(),
		slug: text('slug').notNull(),
		/** PrintFootprint json: width/depth/height in mm plus copies per run. */
		footprint: jsonb('footprint').$type<Record<string, unknown>>().notNull(),
		/** 2D convex hull of the footprint, [x, y][] in mm, centred on the footprint's bbox centre. */
		hull: jsonb('hull').$type<[number, number][]>().notNull(),
		height: doublePrecision('height').notNull(),
		tris: integer('tris').notNull().default(0),
		/** MakeGood's per-object slicer settings (wall_loops, sparse_infill_density, support, brim, layer height). */
		settings: jsonb('settings')
			.$type<Record<string, string>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		/** Relative to uploadsDir(): `print/<templateId>/<slug>.bin`. */
		meshPath: text('mesh_path').notNull(),
		sourceNote: text('source_note').notNull().default(''),
		updatedAt: timestamp('updated_at', TS).notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.templateId, t.slug] })]
);

// ---- Assembly and handoff (milestone 6)

/** Per-build progress on assembly steps, their checks and hardware ticks. */
export const buildAssembly = pgTable(
	'build_assembly',
	{
		buildId: buildId(),
		/** template_assembly_steps.key, or '<stepKey>:check:<checkKey>' / '<stepKey>:hw:<name>' */
		itemKey: text('item_key').notNull(),
		done: boolean('done').notNull().default(false),
		note: text('note').notNull().default(''),
		doneBy: text('done_by').references(() => user.id, { onDelete: 'set null' }),
		doneAt: timestamp('done_at', TS)
	},
	(t) => [primaryKey({ columns: [t.buildId, t.itemKey] })]
);

/** Photos attached to a build (progress, finished chair, handoff). Files live under the uploads dir. */
export const buildPhotos = pgTable(
	'build_photos',
	{
		id: id(),
		buildId: buildId(),
		kind: text('kind').notNull().default('progress'), // progress | finished | handoff
		path: text('path').notNull(),
		thumbPath: text('thumb_path'),
		caption: text('caption').notNull().default(''),
		width: integer('width'),
		height: integer('height'),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		createdAt: createdAt()
	},
	(t) => [index('build_photos_build_idx').on(t.buildId, t.createdAt)]
);

/** Handoff record for a finished chair: one row per build. */
export const buildHandoff = pgTable('build_handoff', {
	buildId: text('build_id')
		.primaryKey()
		.references(() => builds.id, { onDelete: 'cascade' }),
	recipientName: text('recipient_name'),
	organization: text('organization'), // hospital / clinic / family
	contact: text('contact'), // free text; never shown to viewers outside the team
	handedOffOn: text('handed_off_on'), // YYYY-MM-DD
	location: text('location'),
	notes: text('notes').notNull().default(''),
	safetyChecked: boolean('safety_checked').notNull().default(false),
	updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
	updatedAt: timestamp('updated_at', TS)
});

/** A team's own filaments (brand, type, color), reusable across its builds and shown first in pickers. */
export const customFilaments = pgTable(
	'custom_filaments',
	{
		id: id(),
		organizationId: text('organization_id')
			.notNull()
			.references(() => organization.id, { onDelete: 'cascade' }),
		brand: text('brand').notNull(),
		/** Material/type as makers write it: PETG, PETG HF, TPU 95A, PLA+… (drives slot compatibility). */
		material: text('material').notNull(),
		colorName: text('color_name').notNull(),
		hex: text('hex').notNull(),
		/** Optional: finish (matte | silk | glossy | translucent …), hardness (e.g. 95A), product URL, notes. */
		finish: text('finish'),
		hardness: text('hardness'),
		url: text('url'),
		notes: text('notes').notNull().default(''),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		createdAt: createdAt(),
		updatedAt: timestamp('updated_at', TS)
	},
	(t) => [index('custom_filaments_org_idx').on(t.organizationId)]
);

/**
 * What a build has learned about each part from a sliced file (or the printer): real print time and
 * grams, used by arranging and totals instead of estimates. Independent of the build's plate layout.
 */
export const buildPartProfiles = pgTable(
	'build_part_profiles',
	{
		buildId: buildId(),
		partSlug: text('part_slug').notNull(),
		/** Seconds to print one copy of this part (all its pieces), as sliced. */
		secondsPerCopy: doublePrecision('seconds_per_copy'),
		/** Grams per copy by filament role key, as sliced. */
		gramsByRole: jsonb('grams_by_role')
			.$type<Record<string, number>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		/** 'upload:<build_uploads.id>' | 'printer' | 'manual' */
		source: text('source').notNull(),
		/** 'exact' (per-object data) | 'volume-split' (plate total shared by mesh volume) */
		method: text('method').notNull().default('volume-split'),
		/** Snapshot of the filament role and printer the slice was made for (to flag stale data). */
		context: jsonb('context')
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		updatedAt: timestamp('updated_at', TS)
	},
	(t) => [primaryKey({ columns: [t.buildId, t.partSlug] })]
);

// ---- Site admins assigned in-app (in addition to any configured by env). Additive; the
// access rule lives in access.ts.

export const siteAdmin = pgTable('site_admin', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	grantedBy: text('granted_by').references(() => user.id, { onDelete: 'set null' }),
	grantedAt: timestamp('granted_at', TS).notNull().defaultNow()
});

// ---- Printers (read-only status; on the public site reached through OctoEverywhere shared links)

/** A printer a team connects to. Secrets (access codes, API keys, share links) are stored encrypted. */
export const printers = pgTable(
	'printers',
	{
		id: id(),
		organizationId: text('organization_id')
			.notNull()
			.references(() => organization.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		/** elegoo-sdcp | moonraker | octoprint | bambu-lan | (share-link kinds added by the printers agent) */
		kind: text('kind').notNull(),
		host: text('host').notNull(),
		port: integer('port'),
		/** printer catalog id (src/lib/printers/catalog.ts) */
		catalogId: text('catalog_id'),
		/** AES-GCM encrypted JSON of secrets (API key, access code, serial); never sent to the browser. */
		secretEnc: text('secret_enc'),
		enabled: boolean('enabled').notNull().default(true),
		/** Camera override (http/https, same host as the printer); null = automatic default per printer type. LAN-only; may be dropped later. */
		cameraUrl: text('camera_url'),
		cameraEnabled: boolean('camera_enabled').notNull().default(true),
		lastSeenAt: timestamp('last_seen_at', TS),
		/** Last normalised status snapshot (state, progress, file, temps, remaining). */
		lastStatus: jsonb('last_status').$type<Record<string, unknown>>(),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		createdAt: createdAt()
	},
	(t) => [index('printers_org_idx').on(t.organizationId)]
);

/** A print job seen on a printer, optionally linked to a build plate; drives Now printing and auto-logged runs. */
export const printerJobs = pgTable(
	'printer_jobs',
	{
		id: id(),
		printerId: text('printer_id')
			.notNull()
			.references(() => printers.id, { onDelete: 'cascade' }),
		buildId: text('build_id').references(() => builds.id, { onDelete: 'set null' }),
		plateNumber: integer('plate_number'),
		partSlugs: jsonb('part_slugs').$type<string[]>(),
		fileName: text('file_name').notNull().default(''),
		status: text('status').notNull().default('printing'), // printing | paused | done | failed | cancelled
		progress: doublePrecision('progress'),
		startedAt: timestamp('started_at', TS),
		finishedAt: timestamp('finished_at', TS),
		/** print_runs.id once the finished job has been logged (auto or confirmed). */
		runId: text('run_id'),
		createdAt: createdAt()
	},
	(t) => [index('printer_jobs_printer_idx').on(t.printerId, t.startedAt)]
);

/**
 * Per-workspace settings blob (auto-log prints, "expected plate" suggestions per printer, ...).
 * The Spoolman columns (spoolman_url, spoolman_auto_deduct) are gone.
 */
export const organizationSettings = pgTable('organization_settings', {
	organizationId: text('organization_id')
		.primaryKey()
		.references(() => organization.id, { onDelete: 'cascade' }),
	settings: jsonb('settings')
		.$type<Record<string, unknown>>()
		.notNull()
		.default(sql`'{}'::jsonb`),
	updatedAt: timestamp('updated_at', TS)
});
