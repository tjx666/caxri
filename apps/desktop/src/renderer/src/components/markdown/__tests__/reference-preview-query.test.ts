import type { TerminalReferencePreview } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { referencePreviewStaleTime } from '../reference-preview-query';

function github(overrides: Partial<Extract<TerminalReferencePreview, { kind: 'github' }>>) {
    return {
        kind: 'github',
        author: 'a',
        createdAt: 0,
        isDraft: false,
        isMerged: false,
        isPullRequest: true,
        number: 1,
        state: 'open',
        title: 't',
        url: 'https://github.com/o/r/pull/1',
        ...overrides,
    } satisfies TerminalReferencePreview;
}

describe('referencePreviewStaleTime', () => {
    it('re-reads an open, draft, or unanswered pull request after a minute', () => {
        expect(referencePreviewStaleTime(github({}))).toBe(60_000);
        expect(referencePreviewStaleTime(github({ isDraft: true }))).toBe(60_000);
        expect(referencePreviewStaleTime(undefined)).toBe(60_000);
        expect(
            referencePreviewStaleTime({ kind: 'unavailable', reason: 'unreadable' } as never),
        ).toBe(60_000);
    });

    it('trusts a merged or closed pull request and an issue for five minutes', () => {
        expect(referencePreviewStaleTime(github({ isMerged: true, state: 'closed' }))).toBe(
            300_000,
        );
        expect(referencePreviewStaleTime(github({ state: 'closed' }))).toBe(300_000);
        expect(referencePreviewStaleTime(github({ isPullRequest: false }))).toBe(300_000);
    });
});
