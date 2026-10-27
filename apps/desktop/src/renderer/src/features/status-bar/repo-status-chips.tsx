import { useEffect, useState } from 'react';

import type { ProjectStatusOverview } from '@caxri/protocol';
import { GitPullRequest } from 'lucide-react';

import type { CopyFeedbackStatus } from '../../components/copy-feedback';
import {
    COPY_FEEDBACK_RESET_MS,
    copyButtonLabel,
    writeToClipboardWithFeedback,
} from '../../components/copy-feedback';
import { StructuredTooltip } from '../../components/structured-tooltip';
import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { textClipboard } from '../../lib/clipboard';
import { useCaxriQuery } from '../../queries/client';
import { useSelectedSession } from '../../stores/selectors';
import { AcceptanceStatus } from './acceptance-status';
import type { ChipVisibility } from './chip-priority';
import { LinearIssueStatus } from './linear-issue-status';
import { MismatchDot } from './mismatch-dot';
import {
    pullRequestAriaLabel,
    pullRequestElsewhereBranch,
    pullRequestRecoveryCommand,
    pullRequestTooltip,
    pullRequestUnavailableHint,
    pullRequestUnavailableLabel,
} from './pull-request-status-label';
import { StatusInfo } from './status-info';
import { PriorityChipSlot, StatusItem } from './status-item';
import { selectWorkbenchRoot } from './workbench-root-commands';
import { workbenchRootForBranch } from './workbench-root-options';

type Repo = NonNullable<ProjectStatusOverview['repository']>;

/**
 * Matches the Workbench Root picker's closed-state poll, so opening this card reuses the roots that poll already read.
 */
const WORKBENCH_ROOTS_STALE_MS = 60_000;

/**
 * The pull request card's way to the branch it names: `Switch to <branch> Worktree`, through the same confirmation and
 * switch the Workbench Root picker uses. Mounted only while the card is open, so the roots are read on demand rather
 * than polled for every pull request chip. Renders nothing when no single worktree has the branch checked out.
 */
function PullRequestWorktreeSwitch({ branch, sessionId }: { branch: string; sessionId: string }) {
    const { t } = useTranslation();
    const session = useSelectedSession();
    const [isSwitching, setIsSwitching] = useState(false);
    const rootsQuery = useCaxriQuery(
        'session.workbenchRoots',
        { sessionId },
        { staleTime: WORKBENCH_ROOTS_STALE_MS },
    );
    const root = workbenchRootForBranch(
        rootsQuery.data ?? [],
        branch,
        session?.workbenchRootProjectId,
    );
    if (!root) return null;
    return (
        <Button
            variant="secondary"
            size="sm"
            className="mt-2 w-full"
            aria-disabled={isSwitching || undefined}
            onClick={() => {
                if (isSwitching) return;
                setIsSwitching(true);
                void selectWorkbenchRoot(sessionId, root).finally(() => setIsSwitching(false));
            }}
        >
            {t('statusBar.pullRequest.switchWorktree', { branch })}
        </Button>
    );
}

/**
 * The recovery sentence for a failed pull request lookup, plus a button that copies the exact terminal command when one
 * fixes it. Lives in an interactive hover card so the button stays reachable.
 */
function PullRequestUnavailableHint({
    unavailable,
}: {
    unavailable: NonNullable<Repo['pullRequestUnavailable']>;
}) {
    const { t } = useTranslation();
    const [status, setStatus] = useState<CopyFeedbackStatus>('idle');
    useEffect(() => {
        if (status === 'idle') return;
        const timer = setTimeout(() => setStatus('idle'), COPY_FEEDBACK_RESET_MS);
        return () => clearTimeout(timer);
    }, [status]);
    const command = pullRequestRecoveryCommand(unavailable.reason);
    return (
        <>
            <p className="m-0">{pullRequestUnavailableHint(unavailable, t)}</p>
            {command && (
                <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2 w-full"
                    onClick={async () => {
                        // Resolves to a status and never rejects.
                        setStatus(await writeToClipboardWithFeedback(textClipboard, command));
                    }}
                >
                    {copyButtonLabel(
                        status,
                        t('statusBar.pullRequest.hint.copyCommand', { command }),
                        t,
                    )}
                </Button>
            )}
        </>
    );
}

/**
 * The pull request chip. A pull request on another branch carries the same mismatch dot as the Workbench Root picker
 * and names its branch in the accessible name; its card then offers the switch when a worktree has that branch.
 */
function PullRequestStatus({
    branch,
    pullRequest,
    sessionId,
}: {
    branch: string;
    pullRequest: NonNullable<Repo['pullRequest']>;
    sessionId?: string;
}) {
    const { t } = useTranslation();
    const elsewhereBranch = pullRequestElsewhereBranch(pullRequest, branch);
    const canSwitch = Boolean(elsewhereBranch && sessionId);
    return (
        <StatusItem
            icon={
                elsewhereBranch ? (
                    <GitPullRequest aria-hidden="true" data-pull-request-elsewhere="true">
                        <MismatchDot key="pull-request-elsewhere" />
                    </GitPullRequest>
                ) : (
                    <GitPullRequest />
                )
            }
            href={pullRequest.url}
            ariaLabel={pullRequestAriaLabel(pullRequest, branch, t)}
            interactiveTitle={canSwitch}
            title={
                <>
                    <StructuredTooltip {...pullRequestTooltip(pullRequest, branch, t)} />
                    {canSwitch && elsewhereBranch && sessionId && (
                        <PullRequestWorktreeSwitch branch={elsewhereBranch} sessionId={sessionId} />
                    )}
                </>
            }
        >
            #{pullRequest.number}
        </StatusItem>
    );
}

/**
 * The chips derived from the Session's primary repository's delivery metadata. The bar carries no local change counter:
 * the Git panel already shows every changed file with its counts, and a bare `+1 -1` here was read past rather than
 * used. Split out of `StatusBarContext` because every new external-status source adds another visibility branch here,
 * and the footer's own layout should stay readable next to them.
 */
export function RepoStatusChips({
    chipVisibility,
    repo,
    sessionId,
}: {
    chipVisibility: ChipVisibility;
    repo: Repo;
    sessionId?: string;
}) {
    const { t } = useTranslation();
    return (
        <>
            <PriorityChipSlot chip="pullRequest" isHidden={!chipVisibility.pullRequest}>
                {repo.pullRequest && (
                    <PullRequestStatus
                        branch={repo.branch}
                        pullRequest={repo.pullRequest}
                        sessionId={sessionId}
                    />
                )}
                {repo.pullRequestUnavailable && (
                    <StatusInfo
                        icon={<GitPullRequest />}
                        ariaLabel={t('statusBar.pullRequest.unavailableAriaLabel', {
                            label: pullRequestUnavailableLabel(
                                repo.pullRequestUnavailable.reason,
                                t,
                            ),
                            hint: pullRequestUnavailableHint(repo.pullRequestUnavailable, t),
                        })}
                        interactiveTitle
                        title={
                            <PullRequestUnavailableHint unavailable={repo.pullRequestUnavailable} />
                        }
                        className="bg-elevated text-muted"
                        focusable
                    >
                        {pullRequestUnavailableLabel(repo.pullRequestUnavailable.reason, t)}
                    </StatusInfo>
                )}
            </PriorityChipSlot>
            <PriorityChipSlot chip="linearIssue" isHidden={!chipVisibility.linearIssue}>
                {repo.linearIssues.length > 0 && <LinearIssueStatus issues={repo.linearIssues} />}
            </PriorityChipSlot>
            <PriorityChipSlot chip="acceptance" isHidden={!chipVisibility.acceptance}>
                {repo.acceptances.length > 0 && <AcceptanceStatus acceptances={repo.acceptances} />}
            </PriorityChipSlot>
        </>
    );
}
