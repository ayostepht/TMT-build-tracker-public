/**
 * Tiny toast store. Lives outside any one page so a toast survives the card that caused it
 * disappearing. One toast at a time: a new one replaces the one on screen, so toasts never stack over
 * the controls (the replaced toast's Undo is gone with it, which is what a newer action implies).
 */
export interface ToastItem {
	id: number;
	text: string;
	/** Optional action button (e.g. Undo). */
	action?: { label: string; run: () => Promise<void> | void };
}

class Toasts {
	items = $state<ToastItem[]>([]);
	#n = 0;

	/** `ms` defaults to 8 s, or 12 s when the toast carries an action (Undo needs time to be found with a thumb). */
	push(text: string, action?: ToastItem['action'], ms = action ? 12000 : 8000): number {
		const id = ++this.#n;
		this.items = [{ id, text, action }];
		setTimeout(() => this.dismiss(id), ms);
		return id;
	}
	dismiss(id: number) {
		this.items = this.items.filter((t) => t.id !== id);
	}
}

export const toasts = new Toasts();
