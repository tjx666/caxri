import { describe, expect, it } from 'vitest';

import {
    isPathInTrustedFolder,
    MAX_TRUSTED_FOLDER_LENGTH,
    MAX_TRUSTED_FOLDERS,
    normalizeTrustedFolderRule,
} from '../trusted-folders';

describe('normalizeTrustedFolderRule', () => {
    it('accepts a plain absolute folder path', () => {
        expect(normalizeTrustedFolderRule('/Users/me/.lobehub')).toBe('/Users/me/.lobehub');
    });

    it('strips a trailing slash, `.` segments, and duplicate separators', () => {
        expect(normalizeTrustedFolderRule('/Users/me//a/./b/')).toBe('/Users/me/a/b');
    });

    it('trims surrounding whitespace', () => {
        expect(normalizeTrustedFolderRule('  /Users/me/.lobehub  ')).toBe('/Users/me/.lobehub');
    });

    it('rejects an empty or whitespace-only rule', () => {
        expect(normalizeTrustedFolderRule('')).toBeUndefined();
        expect(normalizeTrustedFolderRule(' '.repeat(3))).toBeUndefined();
    });

    it('rejects a relative path', () => {
        expect(normalizeTrustedFolderRule('foo')).toBeUndefined();
        expect(normalizeTrustedFolderRule('./foo')).toBeUndefined();
    });

    it('rejects a home-relative or shell-variable path', () => {
        expect(normalizeTrustedFolderRule('~/x')).toBeUndefined();
        expect(normalizeTrustedFolderRule('$HOME/x')).toBeUndefined();
    });

    it('rejects the filesystem root', () => {
        expect(normalizeTrustedFolderRule('/')).toBeUndefined();
    });

    it('rejects a path containing a `..` segment', () => {
        expect(normalizeTrustedFolderRule('/Users/me/../root')).toBeUndefined();
    });

    it('rejects a path containing a null byte', () => {
        expect(normalizeTrustedFolderRule('/Users/me/\0evil')).toBeUndefined();
    });

    it('rejects an over-length rule', () => {
        expect(
            normalizeTrustedFolderRule(`/${'a'.repeat(MAX_TRUSTED_FOLDER_LENGTH)}`),
        ).toBeUndefined();
    });
});

describe('isPathInTrustedFolder', () => {
    it('matches the exact trusted folder', () => {
        expect(isPathInTrustedFolder('/Users/me/.lobehub', ['/Users/me/.lobehub'])).toBe(true);
    });

    it('matches a descendant of the trusted folder', () => {
        expect(isPathInTrustedFolder('/Users/me/.lobehub/projects/x', ['/Users/me/.lobehub'])).toBe(
            true,
        );
    });

    it('rejects a sibling path that merely shares a prefix', () => {
        expect(isPathInTrustedFolder('/Users/me/.lobehub-other', ['/Users/me/.lobehub'])).toBe(
            false,
        );
    });

    it('ignores an invalid rule in the list', () => {
        expect(
            isPathInTrustedFolder('/Users/me/.lobehub', ['relative/path', '/Users/me/.lobehub']),
        ).toBe(true);
        expect(isPathInTrustedFolder('/Users/me/.lobehub', ['relative/path'])).toBe(false);
    });

    it('ignores rules beyond the bounded rule count', () => {
        const rules = Array.from(
            { length: MAX_TRUSTED_FOLDERS },
            (_unused, index) => `/Users/me/folder-${index}`,
        );
        rules.push('/Users/me/.lobehub');
        expect(isPathInTrustedFolder('/Users/me/.lobehub', rules)).toBe(false);
        expect(isPathInTrustedFolder('/Users/me/folder-0', rules)).toBe(true);
    });
});
