import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ownerWithBuild } from './helpers';

/**
 * API level: the connection options list, a manual (not connected) printer, and the
 * OctoEverywhere link for every printer type that can use one. Links are saved DISABLED and never
 * tested here: a link is a made-up name that must never be looked up or dialled. The outbound
 * rules are covered in src/lib/server/printers/*.test.ts.
 */
const LINK = 'https://shared-e2elinktoken1234.octoeverywhere.com';

const send = (page: Page, method: 'post' | 'patch' | 'delete', url: string, data?: unknown) =>
	(page.request as APIRequestContext)[method](url, {
		data,
		headers: { origin: new URL(page.url()).origin }
	});

test('connection options, a manual printer, and link printers of every type', async ({ page }) => {
	const { buildId } = await ownerWithBuild(page, 'connections');
	// The workspace the build lives in (the chapter or the personal one).
	const view = await (await page.request.get(`/api/builds/${buildId}/view`)).json();
	const org: string = view.build.organizationId;

	// The one list the setup UI renders from.
	const opts = await (await page.request.get('/api/printers/options')).json();
	expect(opts.hosted).toBeUndefined();
	const keys = opts.connectionOptions.map((o: { key: string }) => o.key);
	expect(keys).toEqual([
		'octoeverywhere-elegoo',
		'octoeverywhere-klipper',
		'octoeverywhere-octoprint',
		'manual'
	]);
	expect(
		opts.connectionOptions
			.filter((o: { verifiedOnHardware: boolean }) => o.verifiedOnHardware)
			.map((o: { key: string }) => o.key)
	).toEqual(['octoeverywhere-elegoo']);
	// Signed-out callers get nothing.
	const anon = await page.context().browser()!.newContext();
	expect((await anon.request.get('/api/printers/options')).status()).toBe(401);
	await anon.close();

	// Manual printer: a name is enough.
	const mres = await send(page, 'post', '/api/printers', {
		organizationId: org,
		name: 'Garage printer',
		kind: 'manual'
	});
	expect(mres.status()).toBe(200);
	const manual = (await mres.json()).printer;
	expect(manual).toMatchObject({
		kind: 'manual',
		connection: 'manual',
		host: 'manual',
		status: null,
		blocked: null,
		secretsSet: [],
		cameraEnabled: false,
		enabled: true
	});
	const test = await (
		await send(page, 'post', '/api/printers/test', { organizationId: org, id: manual.id })
	).json();
	expect(test).toMatchObject({ connected: false, manual: true });
	expect(test.message).toMatch(/not connected/);
	const cam = await (await page.request.get(`/api/printers/${manual.id}/camera`)).json();
	expect(cam).toMatchObject({ supported: false, available: false });
	// "Where is it printing?" on a manual printer: the plate is validated, nothing is queued.
	const exp = await send(page, 'post', `/api/printers/${manual.id}/expect`, {
		buildId,
		plateNumber: 99
	});
	expect(exp.status()).toBe(400);
	expect((await exp.json()).error).toMatch(/Unknown plate/);

	// Link printers of each kind, saved disabled. The link is never returned.
	for (const [kind, extra] of [
		['elegoo-sdcp', {}],
		['moonraker', { apiKey: 'KEY' }],
		['octoprint', { apiKey: 'KEY' }]
	] as const) {
		const r = await send(page, 'post', '/api/printers', {
			organizationId: org,
			name: `Link ${kind}`,
			kind,
			enabled: false,
			secrets: { shareLink: LINK, ...extra }
		});
		expect(r.status(), kind).toBe(200);
		const text = await r.text();
		expect(text).not.toMatch(/shared-|octoeverywhere\.com|KEY/);
		const p = JSON.parse(text).printer;
		expect(p).toMatchObject({ kind, connection: 'link', host: 'octoeverywhere', blocked: null });
		expect(p.secretsSet).toContain('shareLink');
		expect(p).not.toHaveProperty('cameraUrl');
		expect(p).not.toHaveProperty('port');
	}

	// There is no way in without a link: an address, or Bambu LAN, is refused; a bad link is
	// refused without echoing it.
	const lan = await send(page, 'post', '/api/printers', {
		organizationId: org,
		name: 'LAN',
		kind: 'moonraker',
		host: '192.168.0.5'
	});
	expect(lan.status()).toBe(400);
	expect((await lan.json()).error).toMatch(/shared link/i);
	const bambu = await send(page, 'post', '/api/printers', {
		organizationId: org,
		name: 'Bambu',
		kind: 'bambu-lan',
		secrets: { shareLink: LINK }
	});
	expect(bambu.status()).toBe(400);
	expect((await bambu.json()).error).toMatch(/Unknown printer type/);
	// LAN discovery is gone.
	expect(
		(await send(page, 'post', '/api/printers/discover', { organizationId: org })).status()
	).toBeGreaterThanOrEqual(400);
	const bad = await send(page, 'post', '/api/printers', {
		organizationId: org,
		name: 'Bad',
		kind: 'moonraker',
		secrets: { shareLink: 'https://evil.example/shared-secret' }
	});
	expect(bad.status()).toBe(400);
	expect(await bad.text()).not.toContain('evil.example');

	// The list: every printer, and no secret anywhere.
	const list = await (await page.request.get(`/api/printers?org=${org}`)).json();
	expect(list.printers).toHaveLength(4);
	expect(JSON.stringify(list)).not.toMatch(/shared-|secretEnc|KEY/);

	// A manual printer becomes a connected one only with a link.
	const up = await send(page, 'patch', `/api/printers/${manual.id}`, { kind: 'octoprint' });
	expect(up.status()).toBe(400);
	const back = await send(page, 'patch', `/api/printers/${manual.id}`, { name: 'Garage' });
	expect((await back.json()).printer).toMatchObject({ name: 'Garage', kind: 'manual' });

	// Clean up.
	for (const p of list.printers)
		expect((await send(page, 'delete', `/api/printers/${p.id}`)).status()).toBeLessThan(300);
});
