import { expect, test } from './fixtures';
import { createChapter, signUp, uniqueEmail } from './helpers';

// Free-text fields stop at the server's cap instead of failing on save.
test('new build and settings fields carry the server length caps', async ({ page }) => {
	await signUp(page, 'Limit Larry', uniqueEmail('limits'));
	await createChapter(page, `Limits ${Date.now().toString(36)}`);
	await page.goto('/builds/new');
	const recipient = page.getByLabel('Recipient (optional)');
	await expect(recipient).toHaveAttribute('maxlength', '200');
	await expect(page.getByLabel('Hospital (optional)')).toHaveAttribute('maxlength', '200');
	await recipient.fill('x'.repeat(250));
	await expect(recipient).toHaveValue('x'.repeat(200));
});
