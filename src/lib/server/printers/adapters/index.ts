import type { PrinterKind } from '#lib/printers/status.ts';
import { shareLinkFor, SHARE_LINK_HOST_PLACEHOLDER } from '#lib/printers/share-link.ts';
import { LINK_ONLY_MESSAGE } from '../outbound';
import { StatusSubject, type AdapterHandle, type ConnectFn, type PrinterConfig } from '../types';
import { connectMoonraker } from './moonraker';
import { connectOctoprint } from './octoprint';
import { connectSdcp } from './sdcp';

/** An adapter handle that reports one status and never opens a socket. */
function idle(message: string, state: 'error' | 'offline'): AdapterHandle {
	const subj = new StatusSubject();
	subj.emit({ state, progress: null, message });
	return {
		status$: (cb) => subj.subscribe(cb),
		close: () => {
			subj.closed = true;
		}
	};
}

/**
 * Only a printer reached through an OctoEverywhere shared link opens a connection (and only to the
 * link host, see `outbound.ts`). Without a usable link (a kind that cannot use one, or secrets lost
 * after a key rotation) nothing is dialled: a row with no link reports an error, and the
 * placeholder host (meaning "reached through a link") reports offline with a clear message.
 */
function guarded(connect: ConnectFn): ConnectFn {
	return (cfg: PrinterConfig): AdapterHandle => {
		const link = shareLinkFor(cfg.kind, cfg.secrets);
		if (!link) {
			if (cfg.host === SHARE_LINK_HOST_PLACEHOLDER)
				return idle(
					'The OctoEverywhere shared link is missing. Edit the printer and enter it again.',
					'offline'
				);
			return idle(LINK_ONLY_MESSAGE, 'error');
		}
		return connect(cfg);
	};
}

/** A printer that is not connected: no socket, no status. The supervisor never even asks. */
const connectManual: ConnectFn = () => ({
	status$: () => () => {},
	close: () => {}
});

export const adapters: Record<PrinterKind, ConnectFn> = {
	'elegoo-sdcp': guarded(connectSdcp),
	moonraker: guarded(connectMoonraker),
	octoprint: guarded(connectOctoprint),
	manual: connectManual
};
