import { expect, test } from './fixtures';
import { ownerWithBuild, signInAsAdmin, signUp, uniqueEmail } from './helpers';
import { newClientContext } from './fixtures';

const SHOTS = 'data/shots-gallery';

test('share a design to the gallery, another user uses it, unsharing keeps their copy', async ({
	page,
	browser,
	request
}) => {
	const name = `Gallery Sunrise ${Date.now().toString(36)}`;
	const email = uniqueEmail('galleryowner');

	// ---- Maker A saves a design from a build and shares it.
	const { buildId } = await ownerWithBuild(page, 'gallery');
	await page.goto(`/builds/${buildId}/design`);
	await expect(page.getByTestId('autosave-status')).toContainText('Saved automatically');
	await page.getByTestId('open-share').click();
	const save = page.getByTestId('share-dialog');
	await save.getByLabel('Design name').fill(name);
	await save.getByRole('button', { name: 'Save design' }).click();
	await expect(page.getByTestId('design-saved')).toContainText(`Saved "${name}"`);

	await page.goto('/designs');
	await page.locator('[data-design]', { hasText: name }).getByRole('link', { name }).click();
	await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
	const designUrl = page.url();
	const slug = new URL(designUrl).pathname.split('/').pop()!;

	// Nothing is listed yet, and the confirmation says what becomes visible.
	await page.getByRole('button', { name: 'Share to the gallery…' }).click();
	const dlg = page.getByTestId('share-gallery-dialog');
	await expect(dlg).toContainText('Olive Owner');
	await expect(dlg).toContainText('never shown');
	await expect(dlg).not.toContainText(email);
	await expect(dlg).not.toContainText('Team name');
	await dlg.getByRole('button', { name: 'Share to the gallery' }).click();
	await expect(page.getByTestId('gallery-card')).toContainText('In the shared gallery');

	await page.goto('/gallery');
	const card = page.locator(`[data-gallery-design="${slug}"]`);
	await expect(card).toContainText(name);
	await expect(card).toContainText('By Olive Owner');
	await expect(card).toContainText('used 0 times');
	await expect(card).not.toContainText('@');

	// ---- Signed-out visitors get nothing.
	const anon = await request.get(`/gallery/${slug}`, { maxRedirects: 0 });
	expect([302, 303, 307]).toContain(anon.status());
	const snap = await request.get(`/api/designs/${slug}/snapshot.png`);
	expect(snap.status()).toBe(401);

	// ---- Maker B sees it, searches, and uses it.
	const ctxB = await newClientContext(browser);
	const b = await ctxB.newPage();
	await signUp(b, 'Bea Builder', uniqueEmail('gallerybee'));
	await b.goto('/gallery');
	const cardB = b.locator(`[data-gallery-design="${slug}"]`);
	await expect(cardB).toBeVisible();
	await b.getByLabel('Search the gallery by name').fill('no-such-design-xyz');
	await b.getByRole('button', { name: 'Search' }).click();
	await expect(b.getByTestId('gallery-empty')).toContainText('Nothing matches');
	await b.goto(`/gallery?q=${encodeURIComponent(name.slice(0, 12))}`);
	await expect(cardB).toBeVisible();
	await b.setViewportSize({ width: 390, height: 844 });
	await b.screenshot({ path: `${SHOTS}/gallery-390.png`, fullPage: true });
	await cardB.getByRole('link', { name }).click();
	await expect(b.getByRole('heading', { level: 1, name })).toBeVisible();
	await expect(b.getByText('Shared by Olive Owner')).toBeVisible();
	// A cannot be hidden by a normal user, and there is no hide button for B.
	await expect(b.getByTestId('hide-from-gallery')).toHaveCount(0);
	await b.screenshot({ path: `${SHOTS}/gallery-detail-390.png`, fullPage: true });
	await b.getByTestId('use-gallery-design').click();
	await expect(b).toHaveURL(/\/designs\/[^/]+#use/);
	await expect(b.getByTestId('copied-from')).toContainText(`Copied from ${name} by Olive Owner`);
	const copyUrl = b.url().split('#')[0];

	// A sees the use count.
	await page.goto('/gallery');
	await expect(page.locator(`[data-gallery-design="${slug}"]`)).toContainText('used 1 time');

	// ---- A stops sharing: gone from the gallery, B's copy stays.
	await page.goto(designUrl);
	await page.getByTestId('gallery-card').getByRole('button', { name: 'Stop sharing' }).click();
	await expect(page.getByText('No longer in the gallery.')).toBeVisible();
	await b.goto('/gallery');
	await expect(b.locator(`[data-gallery-design="${slug}"]`)).toHaveCount(0);
	await b.goto(`/gallery/${slug}`);
	await expect(b.getByText('Not found')).toBeVisible();
	await b.goto(copyUrl);
	await expect(b.getByRole('heading', { level: 1, name })).toBeVisible();
	await expect(b.getByTestId('copied-from')).toHaveCount(0);
	await ctxB.close();
});

test('the gallery is empty-state friendly and signed-out visitors are sent to sign in', async ({
	page
}) => {
	await page.goto('/gallery');
	await expect(page).toHaveURL(/\/login/);
	await signUp(page, 'Eve Empty', uniqueEmail('galleryempty'));
	await page.goto('/gallery?family=brown&q=zzzzzz');
	await expect(page.getByTestId('gallery-empty')).toBeVisible();
});

test('a site admin hides a design, the author sees why, and the admin allows sharing again', async ({
	page,
	browser
}) => {
	const name = `Hidden Dawn ${Date.now().toString(36)}`;
	const { buildId } = await ownerWithBuild(page, 'galleryhide');
	await page.goto(`/builds/${buildId}/design`);
	await expect(page.getByTestId('autosave-status')).toContainText('Saved automatically');
	await page.getByTestId('open-share').click();
	await page.getByTestId('share-dialog').getByLabel('Design name').fill(name);
	await page.getByTestId('share-dialog').getByRole('button', { name: 'Save design' }).click();
	await expect(page.getByTestId('design-saved')).toContainText(`Saved "${name}"`);
	await page.goto('/designs');
	await page.locator('[data-design]', { hasText: name }).getByRole('link', { name }).click();
	await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
	const designUrl = page.url();
	const slug = new URL(designUrl).pathname.split('/').pop()!;
	await page.getByRole('button', { name: 'Share to the gallery…' }).click();
	await page
		.getByTestId('share-gallery-dialog')
		.getByRole('button', { name: 'Share to the gallery' })
		.click();
	await expect(page.getByTestId('gallery-card')).toContainText('In the shared gallery');

	// A site admin hides it.
	const adminCtx = await newClientContext(browser);
	const admin = await adminCtx.newPage();
	await signInAsAdmin(admin);
	await admin.goto(`/gallery/${slug}`);
	await expect(admin.getByRole('heading', { level: 1, name })).toBeVisible();
	await admin.getByTestId('hide-from-gallery').click();
	await admin.getByTestId('unshare-dialog').getByRole('button', { name: 'Hide it' }).click();

	// The author sees the notice and no Share button.
	await page.goto(designUrl);
	await expect(page.getByTestId('gallery-hidden-notice')).toContainText(
		"You can't share it again unless an admin allows it"
	);
	await expect(page.getByRole('button', { name: 'Share to the gallery…' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Allow sharing again' })).toHaveCount(0);

	// Only the admin sees the hidden list and can lift the hide.
	await page.goto('/gallery');
	await expect(page.getByTestId('hidden-designs')).toHaveCount(0);
	await admin.goto('/gallery');
	await admin.getByTestId('hidden-designs').locator('summary').click();
	const entry = admin.locator('[data-hidden-design]', { hasText: name });
	await expect(entry).toContainText('by Olive Owner');
	await expect(entry).not.toContainText('@');
	await admin.setViewportSize({ width: 390, height: 844 });
	await admin.screenshot({ path: `${SHOTS}/gallery-hidden-admin-390.png`, fullPage: true });
	await entry.getByRole('button', { name: 'Allow sharing again' }).click();
	await admin
		.getByTestId('allow-sharing-dialog')
		.getByRole('button', { name: 'Allow sharing again' })
		.click();
	await expect(admin.locator('[data-hidden-design]', { hasText: name })).toHaveCount(0);

	// The author can share again.
	await page.goto(designUrl);
	await expect(page.getByTestId('gallery-hidden-notice')).toHaveCount(0);
	await page.screenshot({ path: `${SHOTS}/design-hidden-1440.png`, fullPage: true });
	await page.getByRole('button', { name: 'Share to the gallery…' }).click();
	await page
		.getByTestId('share-gallery-dialog')
		.getByRole('button', { name: 'Share to the gallery' })
		.click();
	await expect(page.getByTestId('gallery-card')).toContainText('In the shared gallery');
	await adminCtx.close();
});
