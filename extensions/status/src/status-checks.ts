import type { ProjectStatusRepository } from 'caxri';
import { TreeItemCollapsibleState } from 'caxri';

import type { StatusNode } from './status-item';
import { item } from './status-item';
import { durationLabel, ignoredChecksLabel, projectStatusStateLabel } from './status-labels';
import { linkText, stateIcons, stateTones } from './status-presentation';
import { previousChecksNode } from './status-previous-checks';

type PullRequest = NonNullable<ProjectStatusRepository['pullRequest']>;
type PullRequestCheck = PullRequest['checks'][number];

/**
 * More checks of one settled kind than this fold into one summary row. A handful still reads at a glance, but a pull
 * request with a dozen green or still-running checks buried the one that failed under a wall of identical rows and
 * pushed everything below out of a narrow sidebar.
 */
export const CHECKS_COLLAPSE_THRESHOLD = 3;

interface CheckFold {
    /**
     * Default expansion before the user toggles the row. Unfinished checks are what the user is watching, so their fold
     * opens by default; passed checks need no look, so theirs stays closed.
     */
    collapsibleState: TreeItemCollapsibleState;
    /**
     * Stable row id suffix, so a fold keeps its expansion as checks move between groups.
     */
    key: 'in-progress-checks' | 'passed-checks';
    label: (count: number) => string;
    state: PullRequestCheck['state'];
    states: ReadonlySet<PullRequestCheck['state']>;
}

/**
 * Kinds of check that fold when there are many, in display order. A failed, cancelled, neutral, or unknown check is the
 * reason to open the list, so it never folds.
 */
const checkFolds: readonly CheckFold[] = [
    {
        collapsibleState: TreeItemCollapsibleState.Expanded,
        key: 'in-progress-checks',
        /**
         * Uses the same `running` and `queued` words as the row's trailing summary (`1 failing · 3 running · 1
         * queued`), so the fold's count reads as the sum of those two numbers instead of a third vocabulary.
         */
        label: (count) => `${count} checks running or queued`,
        state: 'pending',
        states: new Set(['pending', 'queued']),
    },
    {
        collapsibleState: TreeItemCollapsibleState.Collapsed,
        key: 'passed-checks',
        label: (count) => `${count} checks passed`,
        state: 'success',
        states: new Set(['success']),
    },
];

/**
 * Splits a pull request's checks into the ones listed individually and the groups folded behind a summary row (see
 * {@link checkFolds}). A group folds only past {@link CHECKS_COLLAPSE_THRESHOLD}; listed checks keep the provider's
 * order.
 */
export function partitionPullRequestChecks(checks: readonly PullRequestCheck[]): {
    listed: PullRequestCheck[];
    folded: Array<{ fold: CheckFold; checks: PullRequestCheck[] }>;
} {
    const folded = checkFolds.flatMap((fold) => {
        const members = checks.filter((check) => fold.states.has(check.state));
        return members.length > CHECKS_COLLAPSE_THRESHOLD ? [{ fold, checks: members }] : [];
    });
    const isFolded = (check: PullRequestCheck) =>
        folded.some(({ fold }) => fold.states.has(check.state));
    return { listed: checks.filter((check) => !isFolded(check)), folded };
}

function checkRow(id: string, check: PullRequestCheck): StatusNode {
    const duration = durationLabel(check.durationMs);
    return item(id, check.name, {
        description: duration,
        icon: stateIcons[check.state],
        url: check.url,
        tooltip: {
            badge: {
                label: projectStatusStateLabel(check.state),
                tone: stateTones[check.state],
            },
            rows: [
                ...(duration ? [{ label: 'duration', value: duration }] : []),
                ...(check.url
                    ? [{ label: 'logs', value: linkText(check.url), url: check.url }]
                    : []),
            ],
        },
    });
}

/**
 * The pull request row's children: the previous commit's verdict when the head's checks are not green (it leads, so it
 * stays in view above an expanded list of running checks), each check that needs a look, running and passed ones folded
 * when there are many (see {@link partitionPullRequestChecks}), then the count of checks the user chose to ignore. Row
 * ids keep each check's index in the provider's list, so a check folding or unfolding as others finish does not change
 * its identity.
 */
export function pullRequestCheckNodes(prefix: string, pullRequest: PullRequest): StatusNode[] {
    const { listed, folded } = partitionPullRequestChecks(pullRequest.checks);
    const rowFor = (check: PullRequestCheck) =>
        checkRow(`${prefix}:check:${pullRequest.checks.indexOf(check)}`, check);
    const nodes = [
        ...(pullRequest.previousChecks
            ? [previousChecksNode(prefix, pullRequest.previousChecks)]
            : []),
        ...listed.map(rowFor),
    ];
    for (const { fold, checks } of folded)
        nodes.push(
            item(`${prefix}:${fold.key}`, fold.label(checks.length), {
                icon: stateIcons[fold.state],
                tooltip: {
                    badge: {
                        label: projectStatusStateLabel(fold.state),
                        tone: stateTones[fold.state],
                    },
                },
                children: checks.map(rowFor),
                collapsibleState: fold.collapsibleState,
            }),
        );
    if (pullRequest.hiddenCheckCount > 0) {
        nodes.push(
            item(
                `${prefix}:hidden-checks`,
                `${ignoredChecksLabel(pullRequest.hiddenCheckCount)} hidden`,
                { icon: 'eye-off' },
            ),
        );
    }
    return nodes;
}

/**
 * Check states a pull request row counts in its trailing text, in display order. Only states that ask for attention are
 * counted: a passed, neutral, or cancelled check needs no look, so it never spends the row's width.
 */
const attentionCheckCounts: ReadonlyArray<{
    state: PullRequestCheck['state'];
    label: string;
}> = [
    { state: 'failure', label: 'failing' },
    { state: 'pending', label: 'running' },
    { state: 'queued', label: 'queued' },
];

/**
 * The pull request row's trailing text, such as `1 failing · 3 running`, or undefined when no check is failing,
 * running, or queued. Hidden checks are not in `checks`, so they are never counted here.
 */
export function pullRequestCheckSummary(checks: readonly PullRequestCheck[]): string | undefined {
    const parts = attentionCheckCounts.flatMap(({ state, label }) => {
        const count = checks.filter((check) => check.state === state).length;
        return count > 0 ? [`${count} ${label}`] : [];
    });
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Whether the pull request row opens by default. A failed check is the reason to look, and a running one is what the
 * user is watching, so both keep the row open; a settled, passing pull request stays folded.
 */
export function isPullRequestRowExpanded(pullRequest: PullRequest): boolean {
    return (
        pullRequest.state === 'failure' ||
        pullRequest.state === 'pending' ||
        pullRequest.state === 'queued' ||
        pullRequest.checks.some((check) => check.state === 'pending' || check.state === 'queued')
    );
}
