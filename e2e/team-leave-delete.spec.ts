import { mkdirSync } from 'node:fs';
import { expect, test } from './fixtures';
import { createChapter, invite, joinViaInvite, signUp, uniqueEmail } from './helpers';

const SHOTS = process.env.TLD_SHOTS;

/** Invites `email` as `role` and joins in a new browser context. */
async function addMember(
	browser: Parameters<typeof joinViaInvite>[0],
	owner: Parameters<typeof signUp>[0],
	teamUrl: string,
	name: string,
	role: 'editor' | 'viewer'
) {
	const email = uniqueEmail(name.split(' ')[0].toLowerCase());
	await owner.goto(`${teamUrl}/members`);
	const link = await invite(owner, email, role);
	return joinViaInvite(browser, link, name, email);
}

async function newTeam(page: Parameters<typeof signUp>[0], label: string) {
	await signUp(page, `Olive ${label}`, uniqueEmail(`${label}-owner`));
	const name = `Team ${label} ${Date.now().toString(36)}`;
	await createChapter(page, name);
	return { name, url: page.url().split('?')[0] };
}

test('an editor leaves the team and lands on /workspace with a notice', async ({
	page,
	browser
}) => {
	const team = await newTeam(page, 'leave');
	const ed = await addMember(browser, page, team.url, 'Edie Editor', 'editor');
	try {
		await ed.page.goto(`${team.url}/members`);
		await ed.page.waitForLoadState('networkidle');
		// An editor has no delete section and no picker; only leaving.
		await expect(ed.page.getByTestId('leave-section')).toBeVisible();
		await expect(ed.page.getByTestId('delete-team-section')).toHaveCount(0);
		await expect(ed.page.getByTestId('leave-heir')).toHaveCount(0);
		await expect(ed.page.getByTestId('remove-member')).toHaveCount(0);
		await ed.page.getByTestId('leave-open').click();
		await expect(ed.page.getByTestId('leave-dialog')).toBeVisible();
		await ed.page.getByTestId('leave-confirm').click();

		await expect(ed.page).toHaveURL(/\/teams\/[^/?]+\?notice=left$/);
		await expect(ed.page.getByTestId('team-notice')).toHaveText('You left the team.');
		await expect(ed.page.getByRole('heading', { level: 1, name: 'My builds' })).toBeVisible();
		// Gone from the switcher (one workspace left: no switcher at all) and from its URL.
		await expect(ed.page.getByRole('combobox', { name: 'Team' })).toHaveCount(0);
		const res = await ed.page.goto(team.url);
		expect(res?.status()).toBe(404);
		// The team still exists for the owner, without the editor.
		await page.goto(`${team.url}/members`);
		await expect(page.getByTestId('member-row')).toHaveCount(1);
	} finally {
		await ed.context.close();
	}
});

test('the sole owner hands over to another member and leaves', async ({ page, browser }) => {
	const team = await newTeam(page, 'handover');
	const ed = await addMember(browser, page, team.url, 'Edie Editor', 'editor');
	try {
		await page.goto(`${team.url}/members`);
		await page.waitForLoadState('networkidle');
		// My own row has no Remove button; the leave control asks for an heir first.
		await expect(page.getByTestId('member-you')).toBeVisible();
		await expect(page.getByTestId('remove-member')).toHaveCount(1);
		const open = page.getByTestId('leave-open');
		await expect(open).toBeDisabled();
		await page.getByTestId('leave-heir').selectOption({ label: 'Edie Editor (editor)' });
		await open.click();
		await expect(page.getByTestId('leave-dialog')).toContainText('Edie Editor becomes an owner');
		await page.getByTestId('leave-confirm').click();
		await expect(page).toHaveURL(/\?notice=left$/);
		await expect(page.getByTestId('team-notice')).toBeVisible();

		// The other user is now the owner: they can invite and delete.
		await ed.page.goto(`${team.url}/members`);
		await expect(ed.page.getByTestId('delete-team-section')).toBeVisible();
		await expect(ed.page.getByRole('heading', { name: 'Invite', exact: true })).toBeVisible();
		await expect(ed.page.getByTestId('member-row')).toHaveCount(1);
		await expect(ed.page.getByTestId('leave-only-member')).toHaveText(
			"You're the only one here. Delete the team instead."
		);
	} finally {
		await ed.context.close();
	}
});

test('an owner deletes the team with the typed name; a member loses it', async ({
	page,
	browser
}) => {
	const team = await newTeam(page, 'delete');
	const ed = await addMember(browser, page, team.url, 'Edie Editor', 'editor');
	try {
		await page.goto(`${team.url}/members`);
		await page.waitForLoadState('networkidle');
		await page.getByTestId('delete-team-open').click();
		const dialog = page.getByTestId('delete-team-dialog');
		await expect(dialog).toBeVisible();
		await expect(page.getByTestId('delete-team-summary')).toContainText('0 builds');
		await expect(page.getByTestId('delete-team-summary')).toContainText(
			'1 other person loses access'
		);
		await expect(page.getByTestId('delete-team-summary')).toContainText('0 printers');
		const confirm = page.getByTestId('delete-team-confirm');
		await expect(confirm).toBeDisabled();
		await page.getByTestId('delete-team-name').fill(team.name.slice(0, -1));
		await expect(confirm).toBeDisabled();
		await page.getByTestId('delete-team-name').fill(team.name);
		await confirm.click();

		await expect(page).toHaveURL(/\/teams\/[^/?]+\?notice=deleted$/);
		await expect(page.getByTestId('team-notice')).toHaveText('The team was deleted.');
		await expect(page.getByRole('heading', { level: 1, name: 'My builds' })).toBeVisible();
		expect((await page.goto(team.url))?.status()).toBe(404);

		// The other member no longer sees it, and its URL is a 404 for them too.
		await ed.page.goto('/workspace');
		await expect(ed.page.getByRole('heading', { level: 1, name: 'My builds' })).toBeVisible();
		expect((await ed.page.goto(team.url))?.status()).toBe(404);
		expect((await ed.page.goto(`${team.url}/members`))?.status()).toBe(404);
	} finally {
		await ed.context.close();
	}
});

test('the server refuses a wrong name and a non-owner deleting', async ({ page, browser }) => {
	const team = await newTeam(page, 'refuse');
	const ed = await addMember(browser, page, team.url, 'Edie Editor', 'editor');
	try {
		const post = (p: typeof page, name: string) =>
			p.request.post(`${team.url}/members?/deleteTeam`, {
				headers: { origin: new URL(team.url).origin },
				form: { name }
			});
		const wrong = await post(page, 'not the name');
		expect(await wrong.text()).toContain('Type the team name exactly');
		const notOwner = await post(ed.page, team.name);
		expect(await notOwner.text()).toContain('Only team owners can delete the team');
		await page.goto(`${team.url}/members`);
		await expect(page.getByTestId('member-row')).toHaveCount(2);
	} finally {
		await ed.context.close();
	}
});

test('the server refuses removing your own row', async ({ page }) => {
	const team = await newTeam(page, 'self');
	await page.goto(`${team.url}/members`);
	await page.waitForLoadState('networkidle');
	const myId = await page
		.locator('form[action="?/setRole"] input[name="memberId"]')
		.first()
		.inputValue();
	const res = await page.request.post(`${team.url}/members?/remove`, {
		headers: { origin: new URL(team.url).origin },
		form: { memberId: myId }
	});
	expect(await res.text()).toContain('To remove yourself');
	await page.goto(`${team.url}/members`);
	await expect(page.getByTestId('member-row')).toHaveCount(1);
});

test('phone layout: leave and delete sections do not overflow', async ({ page, browser }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const team = await newTeam(page, 'phone');
	const ed = await addMember(
		browser,
		page,
		team.url,
		'Edie Editor With A Rather Long Name',
		'editor'
	);
	try {
		await page.goto(`${team.url}/members`);
		await page.waitForLoadState('networkidle');
		const overflow = () =>
			page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		await page.getByTestId('leave-heir').selectOption({ index: 1 });
		await expect(page.getByTestId('delete-team-section')).toBeVisible();
		expect(await overflow()).toBeLessThanOrEqual(0);
		if (SHOTS) {
			mkdirSync(SHOTS, { recursive: true });
			await page.getByTestId('leave-section').screenshot({ path: `${SHOTS}/leave-picker-390.png` });
			await page
				.getByTestId('delete-team-section')
				.screenshot({ path: `${SHOTS}/delete-card-390.png` });
		}
		await page.getByTestId('delete-team-open').click();
		await expect(page.getByTestId('delete-team-dialog')).toBeVisible();
		expect(await overflow()).toBeLessThanOrEqual(0);
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/delete-dialog-390.png` });
		await page.getByRole('button', { name: 'Cancel' }).click();
		await page.getByTestId('leave-open').click();
		await expect(page.getByTestId('leave-dialog')).toBeVisible();
		expect(await overflow()).toBeLessThanOrEqual(0);
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/leave-dialog-390.png` });
	} finally {
		await ed.context.close();
	}
});

test('screenshots at 1440 px', async ({ page, browser }) => {
	test.skip(!SHOTS, 'set TLD_SHOTS to a folder to take screenshots');
	await page.setViewportSize({ width: 1440, height: 900 });
	const team = await newTeam(page, 'shots');
	const ed = await addMember(browser, page, team.url, 'Edie Editor', 'editor');
	try {
		mkdirSync(SHOTS!, { recursive: true });
		await page.goto(`${team.url}/members`);
		await page.waitForLoadState('networkidle');
		await page.screenshot({ path: `${SHOTS}/members-1440.png`, fullPage: true });
		await page.getByTestId('leave-heir').selectOption({ index: 1 });
		await page.getByTestId('leave-section').screenshot({ path: `${SHOTS}/leave-picker-1440.png` });
		await page.getByTestId('delete-team-open').click();
		await page.screenshot({ path: `${SHOTS}/delete-dialog-1440.png` });
		await page.getByRole('button', { name: 'Cancel' }).click();
		await ed.page.goto(`${team.url}/members`);
		await ed.page.waitForLoadState('networkidle');
		await ed.page.setViewportSize({ width: 1440, height: 900 });
		await ed.page
			.getByTestId('leave-section')
			.screenshot({ path: `${SHOTS}/leave-plain-1440.png` });
	} finally {
		await ed.context.close();
	}
});
