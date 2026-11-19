import { describe, expect, it } from 'vitest';
import { cameraSupported, checkCameraUrl, resolveCameraUrl } from './camera-url';
import { cleanHost } from './address';

const LINK = 'shared-abcdefgh1234.octoeverywhere.com';

describe('camera support', () => {
	it('every connected kind has a camera, a manual printer has none', () => {
		expect(cameraSupported('elegoo-sdcp')).toBe(true);
		expect(cameraSupported('moonraker')).toBe(true);
		expect(cameraSupported('octoprint')).toBe(true);
		expect(cameraSupported('manual')).toBe(false);
	});
});

describe('same-host guard (link host)', () => {
	const ok = (u: string, h = LINK) => checkCameraUrl(u, h).ok;
	it('accepts https on the link host, default port, any case', () => {
		expect(ok(`https://${LINK}/video`)).toBe(true);
		expect(ok(`https://${LINK.toUpperCase()}/webcam/?action=stream`)).toBe(true);
		expect(ok(`https://${LINK}./video`)).toBe(true);
	});
	it('refuses other hosts, schemes, ports, credentials and junk', () => {
		expect(ok('https://shared-other00000000.octoeverywhere.com/video')).toBe(false);
		expect(ok('http://192.168.1.50:3031/video')).toBe(false);
		expect(ok('http://169.254.169.254/latest')).toBe(false);
		expect(ok(`http://${LINK}/video`)).toBe(false);
		expect(ok(`https://${LINK}:8443/video`)).toBe(false);
		expect(ok(`https://user:pw@${LINK}/video`)).toBe(false);
		expect(ok(`ftp://${LINK}/x`)).toBe(false);
		expect(ok('file:///etc/passwd')).toBe(false);
		expect(ok(`https://${LINK}.evil.test/x`)).toBe(false);
		expect(ok(`https://evil.test/@${LINK}`)).toBe(false);
		expect(ok('not a url')).toBe(false);
		expect(ok(`//${LINK}/x`)).toBe(false);
	});
	it('normalizes hosts', () => {
		expect(cleanHost(' [::1] ')).toBe('::1');
		expect(cleanHost('Host.')).toBe('host');
		expect(cleanHost('Host...')).toBe('host');
	});
	it('resolves relative URLs from a printer API against the link and still guards them', () => {
		expect(resolveCameraUrl('/webcam/?action=stream', `https://${LINK}/`, LINK)?.toString()).toBe(
			`https://${LINK}/webcam/?action=stream`
		);
		expect(resolveCameraUrl('https://evil.test/s', `https://${LINK}/`, LINK)).toBeNull();
		expect(resolveCameraUrl(`http://${LINK}/s`, `https://${LINK}/`, LINK)).toBeNull();
	});
});
