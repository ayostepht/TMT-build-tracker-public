import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { organization, templates } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { templateHardwarePath, templateModelPath, uploadsDir } from '../config';
import { kitCopyBytes, removeTemplateFiles, removeWorkspaceTemplateFiles } from './files';
import { defaultTemplate, forkTemplate } from './fork';

let db: Db;
let baseId: string;

beforeEach(async () => {
	vi.stubEnv('DATA_DIR', mkdtempSync(join(tmpdir(), 'tmt-files-')));
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	baseId = (await defaultTemplate(db)).id;
	for (const org of ['org1', 'org2'])
		await db.insert(organization).values({ id: org, name: org, slug: org, createdAt: new Date() });
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await dropTestDb(db);
});

function put(path: string, bytes: number) {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, Buffer.alloc(bytes));
}

describe('kit copy files', () => {
	it('measures and removes only the files of the workspace copies', async () => {
		const mine = await forkTemplate(db, 'org1', baseId, 'Mine');
		const theirs = await forkTemplate(db, 'org2', baseId, 'Theirs');
		put(templateModelPath(mine), 1000);
		put(templateHardwarePath(mine), 200);
		put(join(uploadsDir(), 'print', mine, 'a.bin'), 30);
		put(join(uploadsDir(), 'guide', mine, '1.webp'), 4);
		put(templateModelPath(theirs), 5000);
		put(templateModelPath(baseId), 9999);
		expect(await kitCopyBytes(db, 'org1')).toBe(1234);
		expect(await kitCopyBytes(db, 'org2')).toBe(5000);

		expect(await removeWorkspaceTemplateFiles(db, 'org1')).toEqual([mine]);
		expect(await kitCopyBytes(db, 'org1')).toBe(0);
		expect(existsSync(join(uploadsDir(), 'print', mine))).toBe(false);
		expect(existsSync(templateModelPath(theirs))).toBe(true);
		expect(existsSync(templateModelPath(baseId))).toBe(true);
	});

	it('ignores ids that could walk the path and missing files', async () => {
		await removeTemplateFiles('../x');
		await removeTemplateFiles('nothing-here');
		expect((await db.select().from(templates)).length).toBeGreaterThan(0);
	});
});
