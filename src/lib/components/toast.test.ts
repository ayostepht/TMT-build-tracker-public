import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toasts } from './toast.svelte.ts';

describe('toast store', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		toasts.items = [];
	});
	afterEach(() => vi.useRealTimers());

	it('shows one toast at a time: a new one replaces the one on screen', () => {
		toasts.push('first');
		toasts.push('second', { label: 'Undo', run: () => {} });
		expect(toasts.items.map((t) => t.text)).toEqual(['second']);
	});

	it('keeps an Undo toast for 12 s and a plain one for 8 s', () => {
		toasts.push('plain');
		vi.advanceTimersByTime(7999);
		expect(toasts.items).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(toasts.items).toHaveLength(0);

		toasts.push('with undo', { label: 'Undo', run: () => {} });
		vi.advanceTimersByTime(11999);
		expect(toasts.items).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(toasts.items).toHaveLength(0);
	});

	it('an old toast timer never dismisses the toast that replaced it', () => {
		toasts.push('old');
		vi.advanceTimersByTime(5000);
		toasts.push('new');
		vi.advanceTimersByTime(4000); // old timer fires here
		expect(toasts.items.map((t) => t.text)).toEqual(['new']);
	});
});
