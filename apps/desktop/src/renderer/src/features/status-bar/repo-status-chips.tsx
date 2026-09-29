import type { CommandId, ProjectStatusOverview } from '@caxri/protocol';
import { formatLineCount } from '@caxri/protocol';
import { FileDiff, GitPullRequest } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { DiffStatSign } from '../../components/diff-stat';
import { StructuredTooltip } from '../../components/structured-tooltip';
import { diffStatLabel } from '../../lib/diff-stat-label';
import { AcceptanceStatus } from './acceptance-status';
import type { ChipVisibility } from './chip-priority';
import { LinearIssueStatus } from './linear-issue-status';
import { pullRequestUnavailableLabel } from './pull-request-status-label';
import { StatusInfo } from './status-info';
import { StatusItem } from './status-item';

type Repo = NonNullable<ProjectStatusOverview['repository']>;

function showSecondarySidebar(command: Extract<CommandId, `secondarySidebar.show${string}`>): void {
    executeCommand(command);
}

function RepoChangesStatus({ additions, deletions }: { additions: number; deletions: number }) {
    return (
        <StatusItem
            className="diff-stat"
            icon={<FileDiff />}
            ariaLabel={`Open changes: ${diffStatLabel({ additions, deletions })}`}
            title={
                <StructuredTooltip
                    title="Primary repository changes"
                    rows={[
                        {
                            label: 'Added',
                            value: (
                                <span className="diff-stat text-diff-stat-added">
                                    <DiffStatSign sign="+" />
                                    {additions} {additions === 1 ? 'line' : 'lines'}
                                </span>
                            ),
                        },
                        {
                            label: 'Removed',
                            value: (
                                <span className="diff-stat text-diff-stat-removed">
                                    <DiffStatSign sign="-" />
                                    {deletions} {deletions === 1 ? 'line' : 'lines'}
                                </span>
                            ),
                        },
                    ]}
                    hint="Click to show in Git"
                />
            }
            onClick={() => showSecondarySidebar('secondarySidebar.showGit')}
        >
            +{formatLineCount(additions)} -{formatLineCount(deletions)}
        </StatusItem>
    );
}

/**
 * The chips derived from the Session's primary repository: delivery metadata first, then the local change counter.
 * Split out of `StatusBarContext` because every new external-status source adds another visibility branch here, and the
 * footer's own layout should stay readable next to them.
 */
export function RepoStatusChips({
    chipVisibility,
    repo,
}: {
    chipVisibility: ChipVisibility;
    repo: Repo;
}) {
    return (
        <>
            {repo.pullRequest && chipVisibility.pullRequest && (
                <StatusItem
                    icon={<GitPullRequest />}
                    href={repo.pullRequest.url}
                    ariaLabel={`Open pull request #${repo.pullRequest.number}`}
                    title={
                        <StructuredTooltip
                            eyebrow={`Pull request #${repo.pullRequest.number}`}
                            title={repo.pullRequest.title}
                            hint="Click to open on GitHub"
                        />
                    }
                >
                    #{repo.pullRequest.number}
                </StatusItem>
            )}
            {repo.pullRequestUnavailable && chipVisibility.pullRequest && (
                <StatusInfo
                    icon={<GitPullRequest />}
                    ariaLabel={`${pullRequestUnavailableLabel(repo.pullRequestUnavailable.reason)}. ${repo.pullRequestUnavailable.hint}`}
                    title={repo.pullRequestUnavailable.hint}
                    className="bg-elevated text-muted"
                    focusable
                >
                    {pullRequestUnavailableLabel(repo.pullRequestUnavailable.reason)}
                </StatusInfo>
            )}
            {repo.linearIssues.length > 0 && chipVisibility.linearIssue && (
                <LinearIssueStatus issues={repo.linearIssues} />
            )}
            {repo.acceptances.length > 0 && chipVisibility.acceptance && (
                <AcceptanceStatus acceptances={repo.acceptances} />
            )}
            <RepoChangesStatus additions={repo.additions} deletions={repo.deletions} />
        </>
    );
}
