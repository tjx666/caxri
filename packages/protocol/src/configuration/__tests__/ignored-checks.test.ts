import { describe, expect, it } from 'vitest';

import {
    isIgnoredCheck,
    MAX_IGNORED_CHECK_LENGTH,
    MAX_IGNORED_CHECKS,
    normalizeIgnoredCheckRule,
} from '../ignored-checks';

describe('normalizeIgnoredCheckRule', () => {
    it('trims surrounding whitespace', () => {
        expect(normalizeIgnoredCheckRule('  build  ')).toBe('build');
    });

    it('keeps inner spaces, which real check names contain', () => {
        expect(normalizeIgnoredCheckRule('CI / unit tests')).toBe('CI / unit tests');
    });

    it('rejects an empty or whitespace-only rule', () => {
        expect(normalizeIgnoredCheckRule('')).toBeUndefined();
        expect(normalizeIgnoredCheckRule(' '.repeat(3))).toBeUndefined();
    });

    it('rejects a rule containing a null byte', () => {
        expect(normalizeIgnoredCheckRule('build\0evil')).toBeUndefined();
    });

    it('rejects an over-length rule', () => {
        expect(normalizeIgnoredCheckRule('a'.repeat(MAX_IGNORED_CHECK_LENGTH + 1))).toBeUndefined();
    });
});

describe('isIgnoredCheck', () => {
    it('returns false when no rule is configured', () => {
        expect(isIgnoredCheck(['build'], [])).toBe(false);
    });

    it('matches an exact check name', () => {
        expect(isIgnoredCheck(['build'], ['build'])).toBe(true);
        expect(isIgnoredCheck(['build'], ['test'])).toBe(false);
    });

    it('matches case-insensitively, because check names are labels rather than paths', () => {
        expect(isIgnoredCheck(['Vercel'], ['vercel'])).toBe(true);
    });

    it('matches any of the check name, the status context, and the workflow name', () => {
        expect(isIgnoredCheck([undefined, 'codecov/patch', undefined], ['codecov/*'])).toBe(true);
        expect(isIgnoredCheck(['unit', undefined, 'Nightly'], ['Nightly'])).toBe(true);
    });

    it('silences every job of a workflow through one workflow-wide pattern', () => {
        const rules = ['Nightly*'];
        expect(isIgnoredCheck(['lint', undefined, 'Nightly E2E'], rules)).toBe(true);
        expect(isIgnoredCheck(['lint', undefined, 'CI'], rules)).toBe(false);
    });

    it('treats `*` as any run and `?` as one character', () => {
        expect(isIgnoredCheck(['deploy-preview'], ['deploy-*'])).toBe(true);
        expect(isIgnoredCheck(['node-20'], ['node-2?'])).toBe(true);
        expect(isIgnoredCheck(['node-200'], ['node-2?'])).toBe(false);
    });

    it('anchors the pattern so a substring alone does not match', () => {
        expect(isIgnoredCheck(['run build now'], ['build'])).toBe(false);
        expect(isIgnoredCheck(['run build now'], ['*build*'])).toBe(true);
    });

    it('escapes regular-expression metacharacters outside the glob wildcards', () => {
        expect(isIgnoredCheck(['build.test'], ['build.test'])).toBe(true);
        expect(isIgnoredCheck(['buildXtest'], ['build.test'])).toBe(false);
    });

    it('skips an invalid rule instead of ignoring the whole list', () => {
        expect(isIgnoredCheck(['build'], [' '.repeat(3), 'build'])).toBe(true);
    });

    it('ignores rules beyond the bounded rule count', () => {
        const rules = Array.from(
            { length: MAX_IGNORED_CHECKS },
            (_unused, index) => `job-${index}`,
        );
        rules.push('build');
        expect(isIgnoredCheck(['build'], rules)).toBe(false);
        expect(isIgnoredCheck(['job-0'], rules)).toBe(true);
    });
});
