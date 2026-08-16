import { describe, expect, it } from 'vitest';

import {
    externalUrlOrigin,
    isExternalUrlTrusted,
    MAX_TRUSTED_DOMAIN_LENGTH,
    MAX_TRUSTED_DOMAINS,
    normalizeTrustedDomainRule,
    parseExternalHttpUrl,
} from '../trusted-domains';

describe('parseExternalHttpUrl', () => {
    it('accepts a well-formed http(s) URL', () => {
        const result = parseExternalHttpUrl('https://example.com/path');
        expect(result).toMatchObject({ ok: true });
        if (result.ok) expect(result.url.hostname).toBe('example.com');
    });

    it('rejects a syntactically invalid URL', () => {
        expect(parseExternalHttpUrl('not a url')).toEqual({ ok: false, reason: 'invalid_url' });
    });

    it('rejects a non-http(s) scheme', () => {
        expect(parseExternalHttpUrl('ftp://example.com')).toEqual({
            ok: false,
            reason: 'unsupported_protocol',
        });
        expect(parseExternalHttpUrl('javascript:alert(1)')).toEqual({
            ok: false,
            reason: 'unsupported_protocol',
        });
    });

    it('rejects embedded credentials', () => {
        expect(parseExternalHttpUrl('https://user:pass@example.com')).toEqual({
            ok: false,
            reason: 'credentials_not_allowed',
        });
    });

    it('rejects a hostname containing a wildcard glyph', () => {
        expect(parseExternalHttpUrl('https://*.example.com')).toEqual({
            ok: false,
            reason: 'invalid_url',
        });
    });

    it('canonicalizes one trailing-dot hostname and rejects a doubled trailing dot', () => {
        const single = parseExternalHttpUrl('https://example.com./path');
        expect(single).toMatchObject({ ok: true });
        if (single.ok) expect(single.url.hostname).toBe('example.com');

        expect(parseExternalHttpUrl('https://example.com../path')).toEqual({
            ok: false,
            reason: 'invalid_url',
        });
    });
});

describe('externalUrlOrigin', () => {
    it('renders scheme, hostname, and a non-default port with no path or query', () => {
        expect(externalUrlOrigin(new URL('https://example.com/path?x=1#y'))).toBe(
            'https://example.com',
        );
        expect(externalUrlOrigin(new URL('https://example.com:8443/path'))).toBe(
            'https://example.com:8443',
        );
    });
});

describe('normalizeTrustedDomainRule', () => {
    it('normalizes a plain origin, dropping path, query, and hash restrictions', () => {
        expect(normalizeTrustedDomainRule('https://example.com')).toBe('https://example.com');
    });

    it('rejects an origin rule that also constrains a path, query, or hash', () => {
        expect(normalizeTrustedDomainRule('https://example.com/path')).toBeUndefined();
        expect(normalizeTrustedDomainRule('https://example.com?x=1')).toBeUndefined();
        expect(normalizeTrustedDomainRule('https://example.com#frag')).toBeUndefined();
    });

    it('normalizes a subdomain wildcard rule and lowercases its scheme and host', () => {
        expect(normalizeTrustedDomainRule('HTTPS://*.Example.COM')).toBe('https://*.example.com');
    });

    it('rejects a wildcard rule over an IP address or a host with no dot', () => {
        expect(normalizeTrustedDomainRule('https://*.127.0.0.1')).toBeUndefined();
        expect(normalizeTrustedDomainRule('https://*.localhost')).toBeUndefined();
    });

    it('rejects a wildcard rule that also constrains a path', () => {
        expect(normalizeTrustedDomainRule('https://*.example.com/path')).toBeUndefined();
    });

    it('rejects an empty, whitespace-only, or over-length rule', () => {
        expect(normalizeTrustedDomainRule(' '.repeat(3))).toBeUndefined();
        expect(normalizeTrustedDomainRule('https://example.com')).toBeDefined();
        expect(
            normalizeTrustedDomainRule(`https://${'a'.repeat(MAX_TRUSTED_DOMAIN_LENGTH)}.com`),
        ).toBeUndefined();
    });
});

describe('isExternalUrlTrusted', () => {
    it('always trusts loopback hosts regardless of the rule list', () => {
        expect(isExternalUrlTrusted(new URL('http://localhost:3000'), [])).toBe(true);
        expect(isExternalUrlTrusted(new URL('http://127.0.0.1:3000'), [])).toBe(true);
    });

    it('matches an exact-origin rule and rejects everything else', () => {
        const rules = ['https://example.com'];
        expect(isExternalUrlTrusted(new URL('https://example.com'), rules)).toBe(true);
        // eslint-disable-next-line unicorn/prefer-https -- asserts the scheme-mismatch rejection path
        expect(isExternalUrlTrusted(new URL('http://example.com'), rules)).toBe(false);
        expect(isExternalUrlTrusted(new URL('https://sub.example.com'), rules)).toBe(false);
        expect(isExternalUrlTrusted(new URL('https://notexample.com'), rules)).toBe(false);
    });

    it('matches a subdomain and the apex domain under a subdomain-wildcard rule', () => {
        const rules = ['https://*.example.com'];
        expect(isExternalUrlTrusted(new URL('https://docs.example.com'), rules)).toBe(true);
        expect(isExternalUrlTrusted(new URL('https://a.b.example.com'), rules)).toBe(true);
        expect(isExternalUrlTrusted(new URL('https://example.com'), rules)).toBe(true);
    });

    it('rejects a lookalike hostname that merely ends with the trusted label', () => {
        const rules = ['https://*.example.com'];
        expect(isExternalUrlTrusted(new URL('https://evil-example.com'), rules)).toBe(false);
        expect(isExternalUrlTrusted(new URL('https://notexample.com'), rules)).toBe(false);
    });

    it('requires the scheme and port to match the wildcard rule', () => {
        const rules = ['https://*.example.com'];
        // eslint-disable-next-line unicorn/prefer-https -- asserts the scheme-mismatch rejection path
        expect(isExternalUrlTrusted(new URL('http://docs.example.com'), rules)).toBe(false);
        expect(isExternalUrlTrusted(new URL('https://docs.example.com:8443'), rules)).toBe(false);
    });

    it('ignores rules beyond the bounded rule count', () => {
        const rules = Array.from(
            { length: MAX_TRUSTED_DOMAINS },
            (_unused, index) => `https://host-${index}.example.com`,
        );
        rules.push('https://trusted-but-out-of-bounds.example.com');
        expect(
            isExternalUrlTrusted(new URL('https://trusted-but-out-of-bounds.example.com'), rules),
        ).toBe(false);
        expect(isExternalUrlTrusted(new URL('https://host-0.example.com'), rules)).toBe(true);
    });
});
