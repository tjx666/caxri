import type { ProjectStatusOverview, PullRequestUnavailable } from '@caxri/protocol';

import type { StructuredTooltipData } from '../../components/structured-tooltip';
import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

type OverviewPullRequest = NonNullable<
    NonNullable<ProjectStatusOverview['repository']>['pullRequest']
>;

/**
 * What the status bar says when the pull request could not be read.
 *
 * Every one of these used to read `PR unknown`, which spent the chip's width on the one word that is true of all eight
 * reasons and useful for none: a missing `gh`, a signed-out CLI, and an exhausted API budget are three different days.
 * The chip names the condition and its hover card keeps the full recovery sentence, so a glance is enough to know
 * whether anything is expected of the user. `other` keeps `unknown` because that is genuinely what it is.
 *
 * `tls` stays separate from `network` even though both mean GitHub is out of reach: the hover card sends one user to
 * check the connection and the other to check a proxy or certificate, and a chip reading `PR offline` would send the
 * second one looking in the wrong place.
 */
export function pullRequestUnavailableLabel(
    reason: PullRequestUnavailable['reason'],
    t: Translate = translate,
): string {
    return t(`statusBar.pullRequest.unavailable.${reason}`);
}

/**
 * The pull request's head branch when it is not the checked-out branch, so the chip can mark the mismatch and name the
 * branch in its accessible name; `undefined` when they match or the head branch is unknown.
 */
export function pullRequestElsewhereBranch(
    pullRequest: Pick<OverviewPullRequest, 'headBranch'>,
    checkedOutBranch: string,
): string | undefined {
    return pullRequest.headBranch !== undefined && pullRequest.headBranch !== checkedOutBranch
        ? pullRequest.headBranch
        : undefined;
}

/**
 * The chip's accessible name. A pull request on another branch says which one, because the mismatch dot is visual only.
 */
export function pullRequestAriaLabel(
    pullRequest: Pick<OverviewPullRequest, 'headBranch' | 'number'>,
    checkedOutBranch: string,
    t: Translate = translate,
): string {
    const branch = pullRequestElsewhereBranch(pullRequest, checkedOutBranch);
    return branch
        ? t('statusBar.pullRequest.ariaLabelElsewhere', { number: pullRequest.number, branch })
        : t('statusBar.pullRequest.ariaLabel', { number: pullRequest.number });
}

/**
 * The pull request chip's hover card. When the Session's own Agent delivered the pull request from another worktree,
 * the chip sits beside a branch that is not the pull request's, so the card names the pull request's branch and where
 * the link came from instead of letting `main #2018` read as "main's pull request".
 */
export function pullRequestTooltip(
    pullRequest: OverviewPullRequest,
    checkedOutBranch: string,
    t: Translate = translate,
): StructuredTooltipData {
    const isElsewhere = pullRequestElsewhereBranch(pullRequest, checkedOutBranch) !== undefined;
    return {
        eyebrow: t('statusBar.pullRequest.eyebrow', { number: pullRequest.number }),
        title: pullRequest.title,
        rows: pullRequest.headBranch
            ? [{ label: t('statusBar.pullRequest.branch'), value: pullRequest.headBranch }]
            : undefined,
        notes: [
            ...(pullRequest.source === 'conversation' ? [t('statusBar.source.conversation')] : []),
            ...(isElsewhere
                ? [t('statusBar.pullRequest.notCheckedOut', { branch: checkedOutBranch })]
                : []),
        ],
        hint: t('statusBar.pullRequest.hint'),
    };
}
