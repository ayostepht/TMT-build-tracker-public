import { defineConfig, devices } from '@playwright/test';
import { E2E_DATABASE_URL } from './e2e/db';

const PORT = Number(process.env.E2E_PORT ?? 4173);
const DB_DIR = 'data/e2e';
// E2E_BASE_URL points the suite at an already running instance (for example the Docker image).
const EXTERNAL = process.env.E2E_BASE_URL;

// The app is built for production, then started with NODE_ENV=test against a fresh Postgres database
// per run (`tmt_e2e` on the local dev Postgres, or E2E_DATABASE_URL; reset by e2e/reset-db.mjs), files
// under data/e2e, over plain http on 127.0.0.1 with PUBLIC_URL unset. NODE_ENV=test plus E2E_AUTH=1 plus
// a database named *_e2e is the only combination that switches on the test-only sign-in route
// (/api/auth/test/sign-in, see src/lib/server/auth-e2e.ts): there is no email/password sign-in.
// The Google client id and secret are dummies: nothing contacts Google unless a spec clicks the
// button, and those specs intercept the request.
export default defineConfig({
	testDir: 'e2e',
	outputDir: 'test-results',
	reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	use: {
		baseURL: EXTERNAL ?? `http://127.0.0.1:${PORT}`,
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: EXTERNAL
		? undefined
		: {
				command: `rm -rf ${DB_DIR} && mkdir -p ${DB_DIR} && node e2e/reset-db.mjs && NODE_ENV=production npm run build && NODE_ENV=test npm start`,
				url: `http://127.0.0.1:${PORT}/api/health`,
				timeout: 240_000,
				reuseExistingServer: false,
				stdout: 'ignore',
				stderr: 'pipe',
				env: {
					E2E_AUTH: '1',
					GOOGLE_CLIENT_ID: 'e2e-google-client-id',
					GOOGLE_CLIENT_SECRET: 'e2e-google-client-secret',
					HOST: '127.0.0.1',
					PORT: String(PORT),
					DATABASE_URL: E2E_DATABASE_URL,
					DATA_DIR: DB_DIR,
					BETTER_AUTH_SECRET: 'e2e-secret-not-for-production-0123456789abcdef',
					BODY_SIZE_LIMIT: '1100M',
					// Behave like an install behind one trusted reverse proxy: the client address
					// (and so the Better Auth rate-limit key) comes from X-Forwarded-For, which
					// the fixtures set per context. A request without it gets 400 on /api/auth/*.
					ADDRESS_HEADER: 'x-forwarded-for',
					XFF_DEPTH: '1',
					PUBLIC_URL: '',
					BETTER_AUTH_URL: '',
					ORIGIN: '',
					// The public-site limits would stop a suite that makes hundreds of accounts in minutes.
					QUOTA_ACCOUNTS_TOTAL: 'off',
					QUOTA_SIGNUPS_PER_DAY: 'off',
					WRITE_RATE_PER_MIN: 'off',
					MIN_FREE_DISK_MB: 'off',
					DEMO_PER_IP_PER_HOUR: '1000',
					// One ready-made spare demo, so the demo spec covers the claim path.
					DEMO_SPARES: '1',
					// A fixed site admin so specs do not depend on who signs up first.
					ADMIN_EMAILS: 'e2e-admin@example.test',
					// The suite runs without the bundled MakeGood kit (specs cover the "missing" state).
					KITPACK_DIR: `${DB_DIR}/no-kitpacks`,
					KITPACK_DOWNLOAD: 'off'
				}
			}
});
