/**
 * This suite deliberately exercises `http://` inputs (protocol-mismatch normalization, exact-origin and wildcard-origin
 * rules rejecting a Loopback default) to prove `parseExternalHttpUrl` and `isExternalUrlTrusted` treat HTTP and HTTPS
 * as distinct origins. `unicorn/prefer-https` correctly flags string literals that look like a real URL to visit, but
 * every literal below is test fixture data whose HTTP scheme is the exact behavior under test, not a URL Caxri would
 * navigate to.
 */
/* eslint-disable unicorn/prefer-https */
import { describe, expect, it } from 'vitest';

import {
    externalUrlOrigin,
    isExternalUrlTrusted,
    normalizeTrustedDomainRule,
    parseExternalHttpUrl,
} from '../trusted-domains';

function parsedUrl(input: string): URL {
    const result = parseExternalHttpUrl(input);
    if (!result.ok) throw new Error(`Expected a valid URL, received ${result.reason}`);
    return result.url;
}

describe('trusted domain normalization', () => {
    it.each([
        ['HTTPS://Example.COM.:443/', 'https://example.com'],
        ['http://Example.COM:3000', 'http://example.com:3000'],
        ['https://*.Example.COM.:443', 'https://*.example.com'],
        ['https://例子.测试', 'https://xn--fsqu00a.xn--0zwm56d'],
        ['http://[::1]:3000', 'http://[::1]:3000'],
    ])('normalizes %s to %s', (input, expected) => {
        expect(normalizeTrustedDomainRule(input)).toBe(expected);
    });

    it.each([
        '*',
        'https://*',
        'https://*.127.0.0.1',
        'https://*.example.com/path',
        'https://user@example.com',
        'https://example.com?query=1',
        'file:///tmp/private',
        'not a domain',
    ])('rejects unsafe rule %s', (input) => {
        expect(normalizeTrustedDomainRule(input)).toBeUndefined();
    });
});

describe('external URL parsing', () => {
    it('canonicalizes case, default ports, IDNA, and a DNS trailing dot', () => {
        const result = parseExternalHttpUrl('HTTPS://例子.测试.:443/a?b=1#c');

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error(result.reason);
        expect(result.url.href).toBe('https://xn--fsqu00a.xn--0zwm56d/a?b=1#c');
        expect(externalUrlOrigin(result.url)).toBe('https://xn--fsqu00a.xn--0zwm56d');
    });

    it.each([
        ['not a URL', 'invalid_url'],
        ['file:///tmp/private', 'unsupported_protocol'],
        ['javascript:alert(1)', 'unsupported_protocol'],
        ['https://user:secret@example.com', 'credentials_not_allowed'],
    ] as const)('rejects %s with %s', (input, reason) => {
        expect(parseExternalHttpUrl(input)).toEqual({ ok: false, reason });
    });
});

describe('trusted domain matching', () => {
    it.each([
        ['https://example.com/a', ['https://example.com'], true],
        ['http://example.com/a', ['https://example.com'], false],
        ['https://example.com:8443/a', ['https://example.com'], false],
        ['https://sub.example.com/a', ['https://example.com'], false],
        ['https://example.com/a', ['https://*.example.com'], true],
        ['https://a.b.example.com/a', ['https://*.example.com'], true],
        ['https://badexample.com/a', ['https://*.example.com'], false],
        ['https://a.example.com:8443/a', ['https://*.example.com:8443'], true],
        ['https://a.example.com/a', ['https://*.example.com:8443'], false],
        ['http://a.example.com:8443/a', ['https://*.example.com:8443'], false],
    ] as const)('matches %s against %j as %s', (input, rules, expected) => {
        expect(isExternalUrlTrusted(parsedUrl(input), rules)).toBe(expected);
    });

    it.each([
        'http://localhost:5173',
        'https://localhost',
        'http://127.0.0.1:3000',
        'https://[::1]:8443',
    ])('trusts loopback by default: %s', (input) => {
        expect(isExternalUrlTrusted(parsedUrl(input), [])).toBe(true);
    });

    it.each([
        'http://0.0.0.0:3000',
        'http://127.0.0.2:3000',
        'http://192.168.1.1',
        'http://10.0.0.1',
        'http://devbox.local',
    ])('does not extend the loopback default to %s', (input) => {
        expect(isExternalUrlTrusted(parsedUrl(input), [])).toBe(false);
    });

    it('fails closed when a persisted rule is not canonicalizable', () => {
        expect(isExternalUrlTrusted(parsedUrl('https://example.com'), ['*', 'broken'])).toBe(false);
    });
});
/* eslint-enable unicorn/prefer-https */
