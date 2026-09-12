import type { GitSummary } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { gitDecorationSummaryUpdate } from './git-decoration-sync';

const summary = { isRepository: false, repositories: [] } satisfies GitSummary;

describe('gitDecorationSummaryUpdate', () => {
    it('keeps the last decorations while the next Session summary is in flight', () => {
        expect(gitDecorationSummaryUpdate(true, undefined)).toEqual({ kind: 'keep' });
    });

    it('applies a resolved summary for the selected Session', () => {
        expect(gitDecorationSummaryUpdate(true, summary)).toEqual({
            kind: 'replace',
            summary,
        });
    });

    it('clears decorations when no Session is selected', () => {
        expect(gitDecorationSummaryUpdate(false, summary)).toEqual({
            kind: 'replace',
            summary: undefined,
        });
        expect(gitDecorationSummaryUpdate(false, undefined)).toEqual({
            kind: 'replace',
            summary: undefined,
        });
    });
});
