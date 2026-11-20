import { describe, expect, it } from 'vitest';
import { providerPhrase } from './sign-in-providers.ts';

describe('providerPhrase', () => {
	it('names one, two or three providers', () => {
		expect(providerPhrase(['google'])).toBe('Google');
		expect(providerPhrase(['google', 'github'])).toBe('Google or GitHub');
		expect(providerPhrase(['github', 'discord'])).toBe('GitHub or Discord');
		expect(providerPhrase(['google', 'github', 'discord'])).toBe('Google, GitHub or Discord');
	});
	it('uses the fixed order and ignores unknown ids', () => {
		expect(providerPhrase(['discord', 'x', 'google'])).toBe('Google or Discord');
	});
	it('is empty when none is enabled', () => {
		expect(providerPhrase([])).toBe('');
	});
});
