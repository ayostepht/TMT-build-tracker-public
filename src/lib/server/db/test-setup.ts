// Vitest setupFile (runs in every test file's worker): keep uploads/kit files out of ./data.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR ||= mkdtempSync(join(tmpdir(), 'tmt-test-data-'));
