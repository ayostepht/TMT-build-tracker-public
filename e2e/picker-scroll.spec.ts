import { expect, test } from './fixtures';
import { ownerWithBuild } from './helpers';

// Short desktop windows (tall browser toolbars): scrolling the swatches with the wheel while the
// pointer hovers them must be steady. Hovering used to change the height of the block above the
// grid, which resized the grid's own scroll area and made the list jump.
for (const size of [
	{ width: 1440, height: 700 },
	{ width: 1650, height: 830 }
]) {
	test(`swatch picker scrolls steadily with the wheel while hovering (${size.width}x${size.height})`, async ({
		page
	}) => {
		await page.setViewportSize(size);
		const { buildId } = await ownerWithBuild(page, `pickscroll${size.height}`);
		await page.goto(`/builds/${buildId}/design`);
		await page.waitForLoadState('networkidle');
		await page.getByRole('tab', { name: 'Colors' }).click();
		await page
			.locator('li.slot[data-role="primary"]')
			.getByRole('button', { name: /^Change filament for/ })
			.first()
			.click();
		const picker = page.getByTestId('swatch-picker');
		await expect(picker.getByTestId('swatch').first()).toBeVisible();
		await expect(picker.getByTestId('swatch').nth(60)).toBeAttached();

		// One scroll container: the picker itself; the grid area does not scroll on its own.
		const nested = await picker.evaluate((el) => {
			const body = el.querySelector('.body') as HTMLElement;
			return getComputedStyle(body).overflowY;
		});
		expect(nested).toBe('visible');
		const scroller = await picker.evaluate((el) => el.scrollHeight > el.clientHeight);
		expect(scroller).toBe(true);

		const top = () => picker.evaluate((el) => el.scrollTop);
		const detailH = () =>
			picker.getByTestId('swatch-detail').evaluate((el) => (el as HTMLElement).offsetHeight);
		const h0 = await detailH();
		const box = (await picker.boundingBox())!;
		const x = box.x + box.width / 2;
		const y = box.y + box.height * 0.7;
		await page.mouse.move(x, y);
		const seen: number[] = [await top()];
		for (let i = 0; i < 12; i++) {
			await page.mouse.wheel(0, 60);
			await page.waitForTimeout(60);
			// Keep hovering whatever swatch is under the pointer, like a real trackpad scroll.
			await page.mouse.move(x + (i % 2), y);
			seen.push(await top());
			expect(await detailH()).toBe(h0);
		}
		for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
		expect(seen[seen.length - 1]).toBeGreaterThan(seen[0] + 200);

		// Scrolling on reaches the end: the last swatch becomes visible.
		for (let i = 0; i < 80; i++) {
			await page.mouse.wheel(0, 400);
			if ((await picker.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)) < 2)
				break;
		}
		const last = picker.getByTestId('swatch').last();
		await expect(last).toBeInViewport();
		// The header (title, Done) stays reachable.
		await expect(picker.getByRole('button', { name: 'Done' })).toBeInViewport();
	});
}

// Screenshots for review: PICKER_SHOTS=<dir> PICKER_TAG=before|after
test('picker screenshots', async ({ page }) => {
	const dir = process.env.PICKER_SHOTS;
	test.skip(!dir, 'only with PICKER_SHOTS');
	const { buildId } = await ownerWithBuild(page, 'pickshots');
	for (const [w, h] of [
		[1650, 830],
		[1440, 700],
		[390, 844]
	]) {
		await page.setViewportSize({ width: w, height: h });
		await page.goto(`/builds/${buildId}/design`);
		await page.waitForLoadState('networkidle');
		await page.getByRole('tab', { name: 'Colors' }).click();
		await page
			.locator('li.slot[data-role="primary"]')
			.getByRole('button', { name: /^Change filament for/ })
			.first()
			.click();
		const picker = page.getByTestId('swatch-picker');
		await expect(picker.getByTestId('swatch').first()).toBeVisible();
		await page.waitForTimeout(500);
		await page.screenshot({ path: `${dir}/${process.env.PICKER_TAG}-${w}x${h}.png` });
	}
});
