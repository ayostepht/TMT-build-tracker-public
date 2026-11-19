import { expect, type Page } from '@playwright/test';

/** Open the Integrations page of a workspace (by its Builds URL) and wait for the printers section. */
export async function gotoIntegrations(page: Page, chapterUrl: string) {
	await page.goto(`${chapterUrl}/integrations`);
	await expect(page.getByTestId('integrations-printers')).toBeVisible();
	await page.waitForLoadState('networkidle');
}
