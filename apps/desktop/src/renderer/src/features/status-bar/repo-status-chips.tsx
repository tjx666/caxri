import type { CommandId, ProjectStatusOverview } from '@caxri/protocol';
import { formatLineCount } from '@caxri/protocol';
import { FileDiff, GitPullRequest } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { DiffStatSign } from '../../components/diff-stat';
import { StructuredTooltip } from '../../components/structured-tooltip';
import { useTranslation } from '../../i18n';
import { diffStatLabel, visibleDiffStatParts } from '../../lib/diff-stat-label';
import { AcceptanceStatus } from './acceptance-status';
import type { ChipVisibility } from './chip-priority';
import { LinearIssueStatus } from './linear-issue-status';
import { pullRequestUnavailableLabel } from './pull-request-status-label';
import { StatusInfo } from './status-info';
import { PriorityChipSlot, StatusItem } from './status-item';

type Repo = NonNullable<ProjectStatusOverview['repository']>;

function showSecondarySidebar(command: Extract<CommandId, `secondarySidebar.show${string}`>): void {
    executeCommand(command);
}

function RepoChangesStatus({ additions, deletions }: { additions: number; deletions: number }) {
    const { t } = useTranslation();
    const visible = visibleDiffStatParts({ additions, deletions });
    return (
        <StatusItem
            className="diff-stat"
            icon={<FileDiff />}
            ariaLabel={t('statusBar.changes.ariaLabel', {
                label: diffStatLabel({ additions, deletions }, t),
            })}
            title={
                <StructuredTooltip
                    title={t('statusBar.changes.title')}
                    rows={[
                        {
                            label: t('statusBar.changes.added'),
                            value: (
                                <span className="diff-stat text-diff-stat-added">
                                    <DiffStatSign sign="+" />
                                    {t(
                                        additions === 1
                                            ? 'statusBar.changes.linesOne'
                                            : 'statusBar.changes.linesOther',
                                        { count: additions },
                                    )}
                                </span>
                            ),
                        },
                        {
                            label: t('statusBar.changes.removed'),
                            value: (
                                <span className="diff-stat text-diff-stat-removed">
                                    <DiffStatSign sign="-" />
                                    {t(
                                        deletions === 1
                                            ? 'statusBar.changes.linesOne'
                                            : 'statusBar.changes.linesOther',
                                        { count: deletions },
                                    )}
                                </span>
                            ),
                        },
                    ]}
                    notes={[t('statusBar.changes.note')]}
                    hint={t('statusBar.changes.hint')}
                />
            }
            onClick={() => showSecondarySidebar('secondarySidebar.showGit')}
        >
            {[
                visible.additions && `+${formatLineCount(additions)}`,
                visible.deletions && `-${formatLineCount(deletions)}`,
            ]
                .filter(Boolean)
                .join(' ')}
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
    const { t } = useTranslation();
    return (
        <>
            {chipVisibility.pullRequest && (
                <PriorityChipSlot chip="pullRequest">
                    {repo.pullRequest && (
                        <StatusItem
                            icon={<GitPullRequest />}
                            href={repo.pullRequest.url}
                            ariaLabel={t('statusBar.pullRequest.ariaLabel', {
                                number: repo.pullRequest.number,
                            })}
                            title={
                                <StructuredTooltip
                                    eyebrow={t('statusBar.pullRequest.eyebrow', {
                                        number: repo.pullRequest.number,
                                    })}
                                    title={repo.pullRequest.title}
                                    hint={t('statusBar.pullRequest.hint')}
                                />
                            }
                        >
                            #{repo.pullRequest.number}
                        </StatusItem>
                    )}
                    {repo.pullRequestUnavailable && (
                        <StatusInfo
                            icon={<GitPullRequest />}
                            ariaLabel={t('statusBar.pullRequest.unavailableAriaLabel', {
                                label: pullRequestUnavailableLabel(
                                    repo.pullRequestUnavailable.reason,
                                    t,
                                ),
                                hint: repo.pullRequestUnavailable.hint,
                            })}
                            title={repo.pullRequestUnavailable.hint}
                            className="bg-elevated text-muted"
                            focusable
                        >
                            {pullRequestUnavailableLabel(repo.pullRequestUnavailable.reason, t)}
                        </StatusInfo>
                    )}
                </PriorityChipSlot>
            )}
            {chipVisibility.linearIssue && (
                <PriorityChipSlot chip="linearIssue">
                    {repo.linearIssues.length > 0 && (
                        <LinearIssueStatus issues={repo.linearIssues} />
                    )}
                </PriorityChipSlot>
            )}
            {chipVisibility.acceptance && (
                <PriorityChipSlot chip="acceptance">
                    {repo.acceptances.length > 0 && (
                        <AcceptanceStatus acceptances={repo.acceptances} />
                    )}
                </PriorityChipSlot>
            )}
            <RepoChangesStatus additions={repo.additions} deletions={repo.deletions} />
        </>
    );
}
