import { describe, expect, it } from 'vitest';

import {
    browserDisplayHost,
    browserNavigation,
    browserPillTitle,
    isSecurePage,
    linkTarget,
} from '../browser-url';

describe('linkTarget', () => {
    it('opens web pages in the app and hands every other scheme to the system', () => {
        expect(linkTarget('https://github.com/acme/app/pull/1')).toBe('inApp');
        expect(linkTarget('http://192.0.2.10:3000/')).toBe('inApp');
        expect(linkTarget('mailto:someone@example.com')).toBe('external');
        expect(linkTarget('tel:+10000000000')).toBe('external');
        expect(linkTarget('not a url')).toBe('external');
    });
});

describe('browserNavigation', () => {
    it('loads pages and blank documents in place but leaves for app schemes', () => {
        expect(browserNavigation('https://example.com/a')).toBe('load');
        expect(browserNavigation('about:blank')).toBe('load');
        expect(browserNavigation('intent://scan/#Intent;scheme=zxing;end')).toBe('external');
        expect(browserNavigation('market://details?id=example')).toBe('external');
    });
});

describe('browserDisplayHost', () => {
    it('names the host without www and keeps a port', () => {
        expect(browserDisplayHost('https://www.example.com/docs?a=1')).toBe('example.com');
        expect(browserDisplayHost('http://192.0.2.10:3000/x')).toBe('192.0.2.10:3000');
        expect(browserDisplayHost('garbage')).toBe('garbage');
    });
});

describe('isSecurePage', () => {
    it('is true only for https', () => {
        expect(isSecurePage('https://example.com')).toBe(true);
        expect(isSecurePage('http://localhost:8080')).toBe(false);
    });
});

describe('browserPillTitle', () => {
    const url = 'https://www.example.com/a';

    it('shows the page title once it has loaded', () => {
        expect(browserPillTitle({ hasLoadFailed: false, title: 'Example', url })).toBe('Example');
    });

    it('names a page without a title, or whose title is its URL, by its host', () => {
        expect(browserPillTitle({ hasLoadFailed: false, title: '', url })).toBe('example.com');
        expect(browserPillTitle({ hasLoadFailed: false, title: url, url })).toBe('example.com');
    });

    it('keeps the host instead of the error page title after a failed load', () => {
        expect(browserPillTitle({ hasLoadFailed: true, title: 'Webpage not available', url })).toBe(
            'example.com',
        );
    });
});
