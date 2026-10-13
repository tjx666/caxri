import { describe, expect, it } from 'vitest';

import { isGitHubName, terminalReferencePreviewRequestSchema } from '../terminal-reference.js';

describe('terminalReferencePreviewRequestSchema', () => {
    it('accepts the names GitHub allows for an owner and a repository', () => {
        expect(
            terminalReferencePreviewRequestSchema.safeParse({
                kind: 'github',
                owner: 'acme-labs',
                repo: 'widgets_v2.js',
                number: 42,
            }).success,
        ).toBe(true);
    });

    it.each([
        ['a path separator', 'acme', 'widgets/issues/1'],
        ['a query', 'acme', 'widgets?'],
        ['a fragment', 'acme', 'widgets#1'],
        ['a percent escape', 'acme', 'widgets%2F1'],
        ['a parent segment', '..', 'user'],
        ['a current segment', 'acme', '.'],
        ['whitespace', 'acme', 'my widgets'],
    ])('rejects a name carrying %s, so it can never reshape the REST path', (_, owner, repo) => {
        expect(
            terminalReferencePreviewRequestSchema.safeParse({
                kind: 'github',
                owner,
                repo,
                number: 1,
            }).success,
        ).toBe(false);
    });
});

describe('isGitHubName', () => {
    it('keeps the 100-character ceiling the schema had before', () => {
        expect(isGitHubName('a'.repeat(100))).toBe(true);
        expect(isGitHubName('a'.repeat(101))).toBe(false);
    });

    it('allows a dotted name that is not a dot segment', () => {
        expect(isGitHubName('.github')).toBe(true);
        expect(isGitHubName('...')).toBe(true);
    });
});
