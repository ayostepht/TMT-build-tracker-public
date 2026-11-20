/** Wording helpers for team and invitation screens. Pure and browser-safe. */

/**
 * Better Auth's raw errors speak of "organizations"; the app says "team". Known messages get a
 * sentence of their own, any other message just has the word swapped, so "organization" never
 * reaches the screen.
 */
const KNOWN: [RegExp, string][] = [
	[/already a member of this organization/i, 'That person is already on this team.'],
	[
		/cannot leave the organization without an owner/i,
		'A team needs at least one owner. Make someone else an owner first.'
	],
	[
		/(only owner|last owner).*(organization|team)|cannot (remove|demote|change).*(only|last) owner/i,
		'A team needs at least one owner. Make someone else an owner first.'
	],
	[/invitation.*already.*(sent|exists)|already invited/i, 'That person already has an invitation.'],
	[/organization not found/i, 'That team was not found.'],
	[/member not found/i, 'That member was not found.'],
	[/invitation not found/i, 'That invitation was not found.'],
	[/not allowed to (invite|update|delete|remove|create)/i, 'Only team owners can do this.']
];

export function teamMessage(
	raw: string | null | undefined,
	fallback = 'Something went wrong'
): string {
	const msg = (raw ?? '').trim();
	if (!msg) return fallback;
	for (const [re, text] of KNOWN) if (re.test(msg)) return text;
	return msg
		.replace(/\borganizations\b/gi, (m) => (m[0] === 'O' ? 'Teams' : 'teams'))
		.replace(/\borganization\b/gi, (m) => (m[0] === 'O' ? 'Team' : 'team'));
}

/**
 * `d•••@example.com`: the first character and the domain, nothing else. A local part shorter than
 * four characters is hidden completely (`•••@example.com`). Used for an invited address shown to
 * someone signed in as a different account.
 */
export function maskEmail(email: string): string {
	const at = email.lastIndexOf('@');
	if (at < 1) return '•••';
	const local = [...email.slice(0, at)];
	return `${local.length >= 4 ? local[0] : ''}•••${email.slice(at)}`;
}
