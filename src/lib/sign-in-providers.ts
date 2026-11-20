/** Display names of the sign-in providers, in the fixed order they are listed in text. */
export const PROVIDER_NAMES = { google: 'Google', github: 'GitHub', discord: 'Discord' } as const;
export type ProviderId = keyof typeof PROVIDER_NAMES;

/**
 * "Google", "Google or GitHub", "Google, GitHub or Discord" for the enabled providers (any
 * order in, fixed order out; unknown ids are ignored). Empty string when none: callers drop the
 * sentence or use a generic one instead of naming a provider.
 */
export function providerPhrase(ids: readonly string[]): string {
	const names = (Object.keys(PROVIDER_NAMES) as ProviderId[])
		.filter((id) => ids.includes(id))
		.map((id) => PROVIDER_NAMES[id]);
	if (names.length <= 1) return names[0] ?? '';
	return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
