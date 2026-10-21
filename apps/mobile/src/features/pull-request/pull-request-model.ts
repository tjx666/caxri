import type { MobilePullRequest, PullRequestMergeBlocker } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import {
    MobileConnectionClosedError,
    MobileGatewayTimeoutError,
} from '../connection/mobile-gateway-errors';

/**
 * What the sheet's primary button does, mirroring the Desktop Status panel's merge button so both surfaces agree:
 *
 * - `merge`: nothing blocks it; the sheet still confirms once, naming only the pull request, so a stray tap never merges.
 * - `confirm`: a reason is worth reading first (`isOverride` when checks failed, labelled Merge anyway).
 * - `refused`: a conflict GitHub would refuse; resolving it is the next step.
 * - `draft`: GitHub cannot merge a draft; the user marks it ready on GitHub.
 * - `waiting`: GitHub has not reported the head yet, so there is nothing to pin the merge to.
 * - `none`: merged or closed.
 */
export type PullRequestMergeAction =
    | { kind: 'merge' }
    | {
          kind: 'confirm';
          blocker: Exclude<PullRequestMergeBlocker, 'conflicting'>;
          isOverride: boolean;
      }
    | { kind: 'refused' }
    | { kind: 'draft' }
    | { kind: 'waiting' }
    | { kind: 'none' };

export function pullRequestMergeAction(pullRequest: MobilePullRequest): PullRequestMergeAction {
    if (pullRequest.lifecycle === 'draft') return { kind: 'draft' };
    if (pullRequest.lifecycle === 'merged' || pullRequest.lifecycle === 'closed')
        return { kind: 'none' };
    const blocker = pullRequest.mergeBlocker;
    if (blocker === 'conflicting') return { kind: 'refused' };
    if (!pullRequest.headSha) return { kind: 'waiting' };
    if (!blocker) return { kind: 'merge' };
    return { kind: 'confirm', blocker, isOverride: blocker === 'checks-failed' };
}

/**
 * The chip's color role: the lifecycle first (merged, closed, draft), then for an open pull request how far it is from
 * merging. Failed checks and conflicts are `danger`; protection or a stale base is `warning` because GitHub may refuse;
 * running checks are `neutral` because they settle by themselves; a ready pull request is `success`.
 */
export type PullRequestTone = 'success' | 'danger' | 'warning' | 'neutral' | 'merged';

export function pullRequestTone(pullRequest: MobilePullRequest): PullRequestTone {
    switch (pullRequest.lifecycle) {
        case 'merged':
            return 'merged';
        case 'closed':
            return 'danger';
        case 'draft':
            return 'neutral';
        default:
            break;
    }
    switch (pullRequest.mergeBlocker) {
        case undefined:
            return 'success';
        case 'conflicting':
        case 'checks-failed':
            return 'danger';
        case 'branch-protection':
        case 'behind':
            return 'warning';
        default:
            return 'neutral';
    }
}

export function pullRequestToneColor(tone: PullRequestTone, theme: MobileTheme): string {
    switch (tone) {
        case 'success':
            return theme.success;
        case 'danger':
            return theme.danger;
        case 'warning':
            return theme.warning;
        case 'merged':
            return theme.merged;
        default:
            return theme.muted;
    }
}

const readinessKeys: Record<PullRequestMergeBlocker, TranslationKey> = {
    'conflicting': 'pullRequest.readiness.conflicting',
    'checks-failed': 'pullRequest.readiness.checksFailed',
    'checks-running': 'pullRequest.readiness.checksRunning',
    'branch-protection': 'pullRequest.readiness.branchProtection',
    'behind': 'pullRequest.readiness.behind',
    'mergeability-unknown': 'pullRequest.readiness.unknown',
};

/**
 * The sheet's one-line status: the lifecycle for a pull request that cannot merge any more, otherwise `Ready to merge`
 * or the one reason it is not, in Desktop's words.
 */
export function pullRequestReadiness(pullRequest: MobilePullRequest, t: Translate): string {
    switch (pullRequest.lifecycle) {
        case 'merged':
            return t('pullRequest.lifecycle.merged');
        case 'closed':
            return t('pullRequest.lifecycle.closed');
        case 'draft':
            return t('pullRequest.lifecycle.draft');
        default:
            return t(
                pullRequest.mergeBlocker
                    ? readinessKeys[pullRequest.mergeBlocker]
                    : 'pullRequest.readiness.ready',
            );
    }
}

/**
 * The checks line: `3 of 9 checks failed: lint, e2e, docs, and 1 more`, `9 checks passed`, `Checks running`, or nothing
 * when the pull request has no checks. Names come from the rollup after ignored checks were filtered out.
 */
/**
 * The sentence saying what the merge will do, as Desktop's Status merge button says it: the method Server Core reported
 * for this repository and the branch it merges into, plus why when it is not squash (the first choice). Without a
 * reported method it states the selection order instead.
 */
export function pullRequestMergeMethodNote(
    pullRequest: Pick<MobilePullRequest, 'baseBranch' | 'mergeMethod'>,
    t: Translate,
): string {
    const { baseBranch, mergeMethod } = pullRequest;
    if (!mergeMethod) return t('pullRequest.mergeMethod');
    const action = t(`pullRequest.method.${mergeMethod}`);
    const sentence = baseBranch
        ? t('pullRequest.method.into', { action, base: baseBranch })
        : t('pullRequest.method.plain', { action });
    if (mergeMethod === 'squash') return sentence;
    return `${sentence} ${t(mergeMethod === 'merge' ? 'pullRequest.method.noSquash' : 'pullRequest.method.noSquashOrMerge')}`;
}

export function pullRequestChecksSummary(
    pullRequest: MobilePullRequest,
    t: Translate,
): string | undefined {
    const { checkCount, failedCheckCount, failedChecks } = pullRequest;
    if (checkCount === 0) return undefined;
    if (failedCheckCount > 0) {
        const rest = failedCheckCount - failedChecks.length;
        const names =
            rest > 0
                ? t('pullRequest.checks.namesWithMore', {
                      names: failedChecks.join(', '),
                      count: rest,
                  })
                : failedChecks.join(', ');
        return t('pullRequest.checks.failed', {
            failed: failedCheckCount,
            total: checkCount,
            names,
        });
    }
    switch (pullRequest.checks) {
        case 'success':
            return t(
                checkCount === 1
                    ? 'pullRequest.checks.passedOne'
                    : 'pullRequest.checks.passedOther',
                {
                    count: checkCount,
                },
            );
        case 'failure':
        case 'cancelled':
            // The rollup failed only through a check an ignore pattern hides from the list.
            return t('pullRequest.checks.someFailed');
        default:
            return t('pullRequest.checks.running');
    }
}

const confirmationKeys: Record<Exclude<PullRequestMergeBlocker, 'conflicting'>, TranslationKey> = {
    'checks-failed': 'pullRequest.confirm.checksFailed',
    'checks-running': 'pullRequest.confirm.checksRunning',
    'branch-protection': 'pullRequest.confirm.branchProtection',
    'behind': 'pullRequest.confirm.behind',
    'mergeability-unknown': 'pullRequest.confirm.unknown',
};

/**
 * Why the merge asks first. The failed-checks reason names the checks so the user knows what they merge past.
 */
export function pullRequestConfirmation(
    pullRequest: MobilePullRequest,
    blocker: Exclude<PullRequestMergeBlocker, 'conflicting'>,
    t: Translate,
): string {
    if (blocker === 'checks-failed')
        return pullRequestChecksSummary(pullRequest, t) ?? t('pullRequest.checks.someFailed');
    return t(confirmationKeys[blocker]);
}

/**
 * Whether the merge request died in transport (timeout or a closed socket) rather than being answered. The answer is
 * unknown: GitHub may well have merged the pull request, so the phone must re-read it instead of claiming a failure.
 */
export function isPullRequestMergeTransportError(error: unknown): boolean {
    return (
        error instanceof MobileGatewayTimeoutError || error instanceof MobileConnectionClosedError
    );
}

/**
 * Whether the sheet shows the merge confirmation page: only while the pull request still has an action that asks first.
 * A refresh can turn a ready pull request into a merged, draft, or conflicting one under the open confirmation; the
 * page then gives way to the status and the `Open on GitHub` and `Done` actions instead of hiding them.
 */
export function shouldShowPullRequestConfirmation(
    isConfirming: boolean,
    action: PullRequestMergeAction,
): boolean {
    return isConfirming && isConfirmablePullRequestAction(action);
}

/**
 * Whether the action is one the sheet confirms before merging (`merge` and `confirm`), narrowing it for the page.
 */
export function isConfirmablePullRequestAction(
    action: PullRequestMergeAction,
): action is Extract<PullRequestMergeAction, { kind: 'confirm' | 'merge' }> {
    return action.kind === 'confirm' || action.kind === 'merge';
}

/**
 * A failed merge in words the user can act on. GitHub's own reason (a protection rule, a moved head) is shown as Server
 * Core relayed it, after a sentence saying the merge did not happen.
 */
export function pullRequestMergeErrorMessage(error: unknown, t: Translate): string {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
    if (isPullRequestMergeTransportError(error)) return t('pullRequest.mergeLostConnection');
    switch (code) {
        case 'CONFLICT':
            return t('pullRequest.mergeConflict');
        case 'NOT_FOUND':
            return t('pullRequest.mergeStale');
        case 'FORBIDDEN':
            return t('pullRequest.mergeForbidden');
        default: {
            const reason = error instanceof Error ? error.message.trim() : '';
            return t('pullRequest.mergeFailed', { reason }).trim();
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
