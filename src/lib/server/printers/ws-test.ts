/** Test helpers for the socket seam (`ws-client.ts`): put a fake or loopback-redirecting class in place of `ws`. */
import { realFactory, setSocketFactory, type SocketPin } from './ws-client';

/** Every socket the adapters open is `new Cls(url)` (the class may ignore the URL). `pin` is recorded on `pins`. */
export function useFakeSocket(Cls: new (url: string) => unknown, pins?: (SocketPin | undefined)[]) {
	setSocketFactory(((url: string, opts?: { pin?: SocketPin }) => {
		pins?.push(opts?.pin);
		return new Cls(url);
	}) as never);
}

export const resetFakeSocket = () => setSocketFactory(null);

/**
 * Link sockets in a test: every socket the adapters open (to the made-up link host) really connects
 * to a loopback `MiniWsServer` on `port` instead. Pair it with `setResolver(async () => [public ip])`
 * so the guard accepts the link name; nothing else is dialled.
 */
export function useLoopbackSocket(port: number) {
	class Redirect extends WebSocket {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		constructor(_url: string) {
			super(`ws://127.0.0.1:${port}/websocket`);
		}
	}
	useFakeSocket(Redirect as never);
}

/** Like `useLoopbackSocket`, but through the real `ws` client (frame cap, handshake) instead of the global WebSocket. */
export function useLoopbackWs(port: number) {
	setSocketFactory((_url, opts) =>
		realFactory(`ws://127.0.0.1:${port}/websocket`, {
			handshakeTimeoutMs: opts?.handshakeTimeoutMs
		})
	);
}
