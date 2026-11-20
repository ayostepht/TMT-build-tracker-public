import { describe, expect, it } from 'vitest';
import { maskEmail, teamMessage } from './team-wording.ts';

describe('teamMessage', () => {
	it('maps the known Better Auth errors', () => {
		expect(teamMessage('User is already a member of this organization')).toBe(
			'That person is already on this team.'
		);
		expect(teamMessage('You cannot leave the organization without an owner')).toBe(
			'A team needs at least one owner. Make someone else an owner first.'
		);
	});
	it('never lets the word organization through', () => {
		expect(teamMessage('Something about the Organization went wrong')).toBe(
			'Something about the Team went wrong'
		);
		expect(teamMessage('No organizations here')).not.toMatch(/organization/i);
	});
	it('falls back when empty', () => {
		expect(teamMessage('', 'Nope')).toBe('Nope');
	});
});

describe('maskEmail', () => {
	it('keeps the first character and the domain for local parts of 4+ characters', () => {
		expect(maskEmail('dana.smith@example.com')).toBe('d•••@example.com');
		expect(maskEmail('dana@example.com')).toBe('d•••@example.com');
	});
	it('hides short local parts completely', () => {
		expect(maskEmail('a@d.com')).toBe('•••@d.com');
		expect(maskEmail('ab@d.com')).toBe('•••@d.com');
		expect(maskEmail('abc@d.com')).toBe('•••@d.com');
	});
	it('masks everything when there is no local part or no @', () => {
		expect(maskEmail('@example.com')).toBe('•••');
		expect(maskEmail('nonsense')).toBe('•••');
	});
});
