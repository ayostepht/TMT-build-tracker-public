import { describe, expect, it } from 'vitest';
import { openUpstream } from './camera';
import { resolveCameraSource, type CameraTarget } from './camera-source';

/**
 * The printer's API key is only ever sent to the printer's own API URL on the link. A camera URL
 * (reported by the printer) is fetched by `openUpstream`, which has no credentials to send, so a
 * camera URL naming another path on the same link host never receives the key. Fetches are
 * recorded here; nothing is dialled.
 */
const HOST = 'shared-testtoken12345678.octoeverywhere.com';
const LINK = `https://${HOST}`;

interface Call {
	url: string;
	headers: Record<string, string>;
	allow: unknown;
}
function recorder(answer: (url: string) => unknown) {
	const calls: Call[] = [];
	const fetchFn = (async (u: string | URL, init?: RequestInit & { allowShareLink?: boolean }) => {
		const url = String(u);
		calls.push({
			url,
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			allow: init?.allowShareLink
		});
		return new Response(JSON.stringify(answer(url)), { status: 200 });
	}) as unknown as typeof fetch;
	return { calls, fetchFn };
}
const secretHeaders = (h: Record<string, string>) =>
	['x-api-key', 'authorization', 'cookie', 'x-auth-token'].filter((k) => k in h);
const target = (o: Partial<CameraTarget>): CameraTarget => ({
	kind: 'moonraker',
	cameraEnabled: true,
	secrets: { shareLink: LINK, apiKey: 'SECRETKEY' },
	...o
});

describe('camera fetches never carry the printer API key', () => {
	it('Moonraker: the key goes to the API request, the camera fetch gets none', async () => {
		const api = recorder(() => ({
			result: { webcams: [{ enabled: true, stream_url: `${LINK}/webcam/?action=stream` }] }
		}));
		const src = await resolveCameraSource(target({}), { fetchFn: api.fetchFn });
		expect(src?.urls).toEqual([`${LINK}/webcam/?action=stream`]);
		expect(api.calls).toHaveLength(1);
		expect(api.calls[0].url).toBe(`${LINK}/server/webcams/list`);
		expect(api.calls[0].headers['x-api-key']).toBe('SECRETKEY');

		const cam = recorder(() => ({}));
		await openUpstream(
			src!.urls[0],
			HOST,
			new AbortController().signal,
			{ connectTimeoutMs: 2000, fetchFn: cam.fetchFn },
			src!.shareLink === true
		);
		expect(cam.calls).toHaveLength(1);
		expect(secretHeaders(cam.calls[0].headers)).toEqual([]);
		expect(cam.calls[0].allow).toBe(true); // only the link host, on a link call
	});

	it('a camera URL on another host or scheme is dropped, so the key can never follow it', async () => {
		const api = recorder(() => ({
			result: {
				webcams: [
					{
						enabled: true,
						stream_url: 'http://192.168.0.9/s',
						snapshot_url: 'https://evil.test/p'
					},
					{ enabled: true, stream_url: `http://${HOST}/s` }
				]
			}
		}));
		const src = await resolveCameraSource(target({}), { fetchFn: api.fetchFn });
		expect(src).toBeNull();
		expect(api.calls.map((c) => c.url)).toEqual([`${LINK}/server/webcams/list`]);
	});

	it('the OctoPrint settings request (the only keyed call) goes to the link API only', async () => {
		const api = recorder(() => ({
			webcam: { webcamEnabled: true, streamUrl: `${LINK}/webcam/?action=stream` }
		}));
		const src = await resolveCameraSource(target({ kind: 'octoprint' }), { fetchFn: api.fetchFn });
		expect(api.calls).toHaveLength(1);
		expect(api.calls[0].url).toBe(`${LINK}/api/settings`);
		expect(api.calls[0].headers['x-api-key']).toBe('SECRETKEY');
		expect(src?.urls).toEqual([`${LINK}/webcam/?action=stream`]);
	});
});
