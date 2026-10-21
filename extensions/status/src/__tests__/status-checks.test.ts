import type { ProjectStatusRepository } from 'caxri';
import { TreeItemCollapsibleState } from 'caxri';
import { describe, expect, it } from 'vitest';

import {
    CHECKS_COLLAPSE_THRESHOLD,
    isPullRequestRowExpanded,
    partitionPullRequestChecks,
    pullRequestCheckNodes,
    pullRequestCheckSummary,
} from '../status-checks';

type PullRequest = NonNullable<ProjectStatusRepository['pullRequest']>;
type Check = PullRequest['checks'][number];

const passed = (name: string): Check => ({ name, state: 'success' });

function pullRequest(checks: Check[], hiddenCheckCount = 0): PullRequest {
    return {
        number: 7,
        title: 'Checks',
        url: 'https://github.com/acme/widget/pull/7',
        state: 'pending',
        checks,
        hiddenCheckCount,
    };
}

describe('partitionPullRequestChecks', () => {
    it('lists every check while the passed ones still read at a glance', () => {
        const checks = [
            { name: 'Lint', state: 'pending' } as const,
            ...Array.from({ length: CHECKS_COLLAPSE_THRESHOLD }, (_, index) =>
                passed(`Pass ${index}`),
            ),
        ];

        expect(partitionPullRequestChecks(checks)).toEqual({ listed: checks, folded: [] });
    });

    it('folds the passed checks once there are many, keeping every other check in view', () => {
        const failing: Check = { name: 'Test', state: 'failure' };
        const running: Check = { name: 'Build', state: 'pending' };
        const greens = Array.from({ length: CHECKS_COLLAPSE_THRESHOLD + 1 }, (_, index) =>
            passed(`Pass ${index}`),
        );

        expect(
            partitionPullRequestChecks([greens[0], failing, ...greens.slice(1), running]),
        ).toEqual({
            listed: [failing, running],
            folded: [expect.objectContaining({ checks: greens })],
        });
    });

    it('folds many running and queued checks too, but never a failure', () => {
        const failing: Check = { name: 'Test', state: 'failure' };
        const waiting: Check[] = [
            ...Array.from({ length: CHECKS_COLLAPSE_THRESHOLD }, (_, index) => ({
                name: `Run ${index}`,
                state: 'pending' as const,
            })),
            { name: 'Queued', state: 'queued' },
        ];
        const nodes = pullRequestCheckNodes('status:repo', pullRequest([...waiting, failing]));

        expect(nodes.map(({ item }) => item.label)).toEqual(['Test', '4 checks running or queued']);
        expect(nodes[1].item.iconPath?.id).toBe('loading');
        // Unfinished checks are what the user is watching, so their fold opens by default.
        expect(nodes[1].item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
        expect(nodes[1].children?.map(({ item }) => item.label)).toEqual(
            waiting.map((check) => check.name),
        );
    });
});

describe('pullRequestCheckNodes', () => {
    it('puts the passed checks behind one collapsed summary row, before the ignored count', () => {
        const running: Check = { name: 'Build', state: 'pending' };
        const greens = Array.from({ length: 5 }, (_, index) => passed(`Pass ${index}`));
        const nodes = pullRequestCheckNodes('status:repo', pullRequest([...greens, running], 1));

        expect(nodes.map(({ item }) => item.label)).toEqual([
            'Build',
            '5 checks passed',
            '1 ignored check hidden',
        ]);
        const summary = nodes[1];
        expect(summary.item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
        expect(summary.item.iconPath?.id).toBe('circle-check');
        expect(summary.children?.map(({ item }) => item.label)).toEqual(
            greens.map((check) => check.name),
        );
        // A check keeps its provider index as its identity whether it is listed or folded.
        expect(nodes[0].item.id).toBe('status:repo:check:5');
        expect(summary.children?.[0].item.id).toBe('status:repo:check:0');
    });
});

describe('pullRequestCheckSummary', () => {
    it('counts only the checks that ask for attention, failing first', () => {
        expect(
            pullRequestCheckSummary([
                { name: 'Build', state: 'pending' },
                passed('Lint'),
                { name: 'Test', state: 'failure' },
                { name: 'E2E', state: 'pending' },
                { name: 'Deploy', state: 'queued' },
                { name: 'Docs', state: 'pending' },
            ]),
        ).toBe('1 failing · 3 running · 1 queued');
    });

    it('counts a cancelled check so a cancelled-only red pull request says why', () => {
        expect(pullRequestCheckSummary([passed('Lint'), { name: 'E2E', state: 'cancelled' }])).toBe(
            '1 cancelled',
        );
        expect(
            pullRequestCheckSummary([
                { name: 'Test', state: 'failure' },
                { name: 'E2E', state: 'cancelled' },
                { name: 'Build', state: 'pending' },
            ]),
        ).toBe('1 failing · 1 cancelled · 1 running');
    });

    it('says nothing when every check settled without a failure', () => {
        expect(
            pullRequestCheckSummary([passed('Lint'), { name: 'Skip', state: 'neutral' }]),
        ).toBeUndefined();
        expect(pullRequestCheckSummary([])).toBeUndefined();
    });
});

describe('isPullRequestRowExpanded', () => {
    it('opens while checks are running or failed and folds a passing pull request', () => {
        const running = pullRequest([{ name: 'Build', state: 'pending' }]);
        expect(isPullRequestRowExpanded(running)).toBe(true);
        const failed = { ...pullRequest([{ name: 'Build', state: 'failure' }]), state: 'failure' };
        expect(isPullRequestRowExpanded(failed as PullRequest)).toBe(true);
        const settled = pullRequest([passed('Build')]);
        expect(isPullRequestRowExpanded({ ...settled, state: 'success' })).toBe(false);
    });
});
