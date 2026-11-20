import { expect, test } from './fixtures';

// Link previews (Messages, Slack, Discord, Facebook) read these tags from the server-rendered HTML.
const PAGES = [
	{ path: '/', title: /TMT Build Tracker/ },
	{ path: '/demo', title: /Try the demo/ },
	{ path: '/login', title: /Sign in/ },
	{ path: '/privacy', title: /Privacy/ },
	{ path: '/terms', title: /Terms/ }
];

for (const { path, title } of PAGES) {
	test(`${path} has link-preview tags with an absolute image`, async ({ page, request }) => {
		await page.goto(path);
		const meta = (sel: string) => page.locator(`head ${sel}`).first().getAttribute('content');
		const origin = new URL(page.url()).origin;
		await expect(page).toHaveTitle(title);
		expect(await meta('meta[property="og:site_name"]')).toBe('TMT Build Tracker');
		expect(await meta('meta[property="og:type"]')).toBe('website');
		expect(await meta('meta[property="og:title"]')).toMatch(title);
		expect((await meta('meta[property="og:description"]'))!.length).toBeGreaterThan(20);
		expect((await meta('meta[name="description"]'))!.length).toBeGreaterThan(20);
		expect(await meta('meta[property="og:url"]')).toBe(origin + path);
		expect(await page.locator('head link[rel="canonical"]').getAttribute('href')).toBe(
			origin + path
		);
		expect(await meta('meta[name="twitter:card"]')).toBe('summary_large_image');
		expect(await meta('meta[property="og:image:width"]')).toBe('1200');
		expect(await meta('meta[property="og:image:height"]')).toBe('630');
		expect((await meta('meta[property="og:image:alt"]'))!.length).toBeGreaterThan(10);
		const image = (await meta('meta[property="og:image"]'))!;
		expect(image).toMatch(/^https?:\/\//);
		expect(await meta('meta[name="twitter:image"]')).toBe(image);
		// a crawler fetches the image without cookies
		const res = await request.get(image);
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toMatch(/^image\/png/);
		expect(res.headers()['cache-control'] ?? '').not.toMatch(/no-store/);
	});
}

test('the home hero hides inactive variant parts when the model is installed', async ({
	request
}) => {
	// The e2e server has no kit pack, so the hero is null; with one, `hidden` is the template's
	// non-default variant parts (unit test home-hero.test.ts checks the list itself).
	const res = await request.get('/__data.json');
	expect(res.ok()).toBe(true);
	const body = await res.text();
	if (body.includes('"partRoles"')) expect(body).toContain('"hidden"');
});
