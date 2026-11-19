import { describe, expect, it } from 'vitest';
import { authRequestHeaders, clientAddress, trustCloudflare } from './client-ip.ts';

describe('Cloudflare mode (TRUST_CLOUDFLARE)', () => {
	const cf = { TRUST_CLOUDFLARE: '1' };
	const sock = () => '10.0.0.1';

	it('is on for 1 and true only', () => {
		expect(trustCloudflare({ TRUST_CLOUDFLARE: '1' })).toBe(true);
		expect(trustCloudflare({ TRUST_CLOUDFLARE: 'TRUE' })).toBe(true);
		expect(trustCloudflare({ TRUST_CLOUDFLARE: '0' })).toBe(false);
		expect(trustCloudflare({ TRUST_CLOUDFLARE: 'yes' })).toBe(false);
		expect(trustCloudflare({})).toBe(false);
	});

	it('takes the client from CF-Connecting-IP and ignores X-Forwarded-For and the socket', () => {
		const h = authRequestHeaders(
			new Headers({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '6.6.6.6' }),
			sock,
			cf
		);
		expect(h?.get('x-forwarded-for')).toBe('203.0.113.9');
	});

	it('accepts IPv6 and normalises a mapped IPv4', () => {
		expect(clientAddress(new Headers({ 'cf-connecting-ip': '2001:db8::7' }), sock, cf)).toBe(
			'2001:db8:0:0::'
		);
		expect(clientAddress(new Headers({ 'cf-connecting-ip': '::ffff:203.0.113.5' }), sock, cf)).toBe(
			'203.0.113.5'
		);
	});

	it('fails closed without a usable CF-Connecting-IP (never falls back to the socket or XFF)', () => {
		expect(clientAddress(new Headers(), sock, cf)).toBeNull();
		expect(clientAddress(new Headers({ 'x-forwarded-for': '6.6.6.6' }), sock, cf)).toBeNull();
		expect(clientAddress(new Headers({ 'cf-connecting-ip': 'nope' }), sock, cf)).toBeNull();
		expect(
			clientAddress(new Headers({ 'cf-connecting-ip': '1.2.3.4, 5.6.7.8' }), sock, cf)
		).toBeNull();
		expect(clientAddress(new Headers({ 'cf-connecting-ip': 'fe80::1%eth0' }), sock, cf)).toBeNull();
		expect(authRequestHeaders(new Headers(), sock, cf)).toBeNull();
	});

	it('ignores CF-Connecting-IP when the mode is off', () => {
		const h = authRequestHeaders(
			new Headers({ 'cf-connecting-ip': '6.6.6.6' }),
			() => '192.0.2.10',
			{}
		);
		expect(h?.get('x-forwarded-for')).toBe('192.0.2.10');
	});
});
