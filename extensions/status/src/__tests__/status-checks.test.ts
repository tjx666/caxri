import type { ProjectStatusRepository } from 'caxri';
import { TreeItemCollapsibleState } from 'caxri';
import { describe, expect, it } from 'vitest';

import {
    partitionPullRequestChecks,
    PASSED_CHECKS_COLLAPSE_THRESHOLD,
    pullRequestCheckNodes,
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
            ...Array.from({ length: PASSED_CHECKS_COLLAPSE_THRESHOLD }, (_, index) =>
                passed(`Pass ${index}`),
            ),
        ];

        expect(partitionPullRequestChecks(checks)).toEqual({ listed: checks, folded: [] });
    });

    it('folds the passed checks once there are many, keeping every other check in view', () => {
        const failing: Check = { name: 'Test', state: 'failure' };
        const running: Check = { name: 'Build', state: 'pending' };
        const greens = Array.from({ length: PASSED_CHECKS_COLLAPSE_THRESHOLD + 1 }, (_, index) =>
            passed(`Pass ${index}`),
        );

        expect(
            partitionPullRequestChecks([greens[0], failing, ...greens.slice(1), running]),
        ).toEqual({ listed: [failing, running], folded: greens });
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
