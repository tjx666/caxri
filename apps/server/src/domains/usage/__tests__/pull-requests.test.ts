import { describe, expect, it } from 'vitest';

import type { PullRequestOutcomeRow } from '../../db';
import type { ExternalStatusRunner } from '../../external-status';
import { fetchPullRequestOutcomes, isRefreshDue, parsePullRequestUrl } from '../pull-requests';

function outcome(state: PullRequestOutcomeRow['state'], checkedAt: number): PullRequestOutcomeRow {
    return {
        url: 'https://github.com/acme/widgets/pull/1',
        state,
        title: '',
        createdAt: null,
        mergedAt: null,
        additions: 0,
        deletions: 0,
        checkedAt,
    };
}

describe('parsePullRequestUrl', () => {
    it('accepts only canonical GitHub pull request URLs', () => {
        expect(parsePullRequestUrl('https://github.com/acme/widgets/pull/12')).toEqual({
            owner: 'acme',
            repo: 'widgets',
            number: 12,
        });
        expect(
            parsePullRequestUrl('https://github.com/acme/widgets/pull/12/files'),
        ).toBeUndefined();
    });
});

describe('isRefreshDue', () => {
    it('rechecks open pull requests periodically and never rechecks final ones', () => {
        expect(isRefreshDue(undefined, 0)).toBe(true);
        expect(isRefreshDue(outcome('open', 0), 29 * 60_000)).toBe(false);
        expect(isRefreshDue(outcome('open', 0), 30 * 60_000)).toBe(true);
        expect(isRefreshDue(outcome('merged', 0), Number.MAX_SAFE_INTEGER)).toBe(false);
        expect(isRefreshDue(outcome('missing', 0), 8 * 24 * 3_600_000)).toBe(true);
    });
});

describe('fetchPullRequestOutcomes', () => {
    it('saves normalized outcomes fetched with fixed argv', async () => {
        const calls: string[][] = [];
        const runner: ExternalStatusRunner = (_command, arguments_) => {
            calls.push([...arguments_]);
            return Promise.resolve(
                JSON.stringify({
                    state: 'MERGED',
                    title: 'Add widgets',
                    createdAt: '2026-03-01T00:00:00Z',
                    mergedAt: '2026-03-02T00:00:00Z',
                    additions: 4,
                    deletions: 1,
                }),
            );
        };
        const saved: PullRequestOutcomeRow[] = [];
        const counts = await fetchPullRequestOutcomes(
            ['https://github.com/acme/widgets/pull/9', 'not a url'],
            runner,
            '/work',
            (row) => saved.push(row),
            () => 5,
        );

        expect(counts.fetched).toBe(1);
        expect(calls).toEqual([
            [
                'pr',
                'view',
                '9',
                '--repo',
                'acme/widgets',
                '--json',
                'state,title,createdAt,mergedAt,additions,deletions',
            ],
        ]);
        expect(saved).toEqual([
            {
                url: 'https://github.com/acme/widgets/pull/9',
                state: 'merged',
                title: 'Add widgets',
                createdAt: Date.parse('2026-03-01T00:00:00Z'),
                mergedAt: Date.parse('2026-03-02T00:00:00Z'),
                additions: 4,
                deletions: 1,
                checkedAt: 5,
            },
        ]);
    });
});
