import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    LIMIT_WARNING_PERCENT,
    limitBarTone,
    pullRequestTileDetail,
    usageRowStatusLabel,
    usageShare,
    usageShareBasis,
} from '../usage-presentation';

describe('plan limit bar tone', () => {
    it('draws a limit as a chart quantity until it nears the cap', () => {
        expect(limitBarTone(0)).toBe('chart');
        expect(limitBarTone(LIMIT_WARNING_PERCENT - 0.5)).toBe('chart');
        expect(limitBarTone(LIMIT_WARNING_PERCENT)).toBe('warning');
        expect(limitBarTone(100)).toBe('warning');
    });
});

describe('share bars', () => {
    const coverage = (unpricedModels: string[]) => ({
        coverage: {
            agentSessions: 1,
            unavailable: 0,
            pendingScans: 0,
            pendingPullRequests: 0,
            unpricedModels,
        },
    });

    it('draws shares from cost only when every model is priced', () => {
        expect(usageShareBasis({ ...coverage([]), totals: { costUsd: 4 } })).toBe('cost');
        expect(usageShareBasis({ ...coverage(['mystery-model']), totals: { costUsd: 4 } })).toBe(
            'tokens',
        );
        expect(usageShareBasis({ ...coverage([]), totals: { costUsd: 0 } })).toBe('tokens');
    });

    it('falls back to tokens so unpriced rows with tokens still get a bar', () => {
        const total = { costUsd: 0, tokens: 400 };
        expect(usageShare({ costUsd: 0, tokens: 100 }, total, 'tokens')).toBe(0.25);
        expect(usageShare({ costUsd: 1, tokens: 100 }, { costUsd: 4, tokens: 400 }, 'cost')).toBe(
            0.25,
        );
        expect(usageShare({ costUsd: 0, tokens: 0 }, { costUsd: 0, tokens: 0 }, 'tokens')).toBe(0);
    });
});

describe('pull request tile detail', () => {
    const lines = String;

    it('leaves out a line count that changed nothing', () => {
        expect(
            pullRequestTileDetail(
                translate,
                { linesAdded: 0, linesDeleted: 0, pullRequestsCreated: 1200 },
                lines,
            ),
        ).toEqual(['1,200 opened']);
    });

    it('keeps the line count and the opened count as separate facts', () => {
        expect(
            pullRequestTileDetail(
                translate,
                { linesAdded: 12, linesDeleted: 3, pullRequestsCreated: 2 },
                lines,
            ),
        ).toEqual(['+12 -3 lines', '2 opened']);
    });
});

describe('usage row status labels', () => {
    it('names every state a muted row stands for', () => {
        expect(
            usageRowStatusLabel(translate, {
                isRemoved: true,
                isOutsideCaxri: false,
                kind: 'project',
            }),
        ).toBe('Removed');
        expect(
            usageRowStatusLabel(translate, {
                isRemoved: false,
                isOutsideCaxri: true,
                kind: 'project',
            }),
        ).toBeUndefined();
        expect(
            usageRowStatusLabel(translate, {
                isDeleted: true,
                isOutsideCaxri: false,
                kind: 'session',
            }),
        ).toBe('Deleted');
        expect(
            usageRowStatusLabel(translate, {
                isDeleted: false,
                isOutsideCaxri: true,
                kind: 'session',
            }),
        ).toBe('Outside Caxri');
        expect(
            usageRowStatusLabel(translate, {
                isDeleted: false,
                isOutsideCaxri: false,
                kind: 'session',
            }),
        ).toBeUndefined();
    });
});
