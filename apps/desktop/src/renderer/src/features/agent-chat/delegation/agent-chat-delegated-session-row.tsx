import type { AgentDelegationSession } from '@caxri/protocol';
import { formatNoticeableDuration } from '@caxri/protocol';

import { useClockTick } from '@/hooks/use-clock-tick';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';
import { openExternalUrl } from '../../../lib/external-link';
import { cn } from '../../../lib/utilities';
import { useProjectById, useSessionById } from '../../../stores/selectors';
import { pushToast } from '../../../stores/toasts';
import {
    delegationCopy,
    delegationCopyInput,
    isDelegationCopyClockDependent,
} from '../../delegation/delegation-copy';
import { delegationElapsedMs } from '../../delegation/delegation-feed';
import { delegationPresetSummary } from '../../delegation/delegation-preset';
import { DelegationPresetChip } from '../../delegation/delegation-preset-chip';
import { DelegationRetryControls } from '../../delegation/delegation-retry-controls';
import { useSessionPullRequest } from '../../primary-sidebar/hooks/use-session-pull-request';
import { SessionPullRequestIndicator } from '../../primary-sidebar/session-pull-request-indicator';
import { sessionTitleForDisplay } from '../../session/session-title';
import {
    delegatedOwnPullRequest,
    delegatedSessionLine,
    delegationPrFilesLabel,
} from './agent-chat-delegated-sessions';
import { AgentChatDelegationGlyph } from './agent-chat-delegation-glyph';
import type { DelegatedCostLabel } from './cost/agent-chat-delegated-cost';
import { useCanOpenDelegatedChild } from './hooks/use-can-open-delegated-child';
import { openDelegatedChild } from './side-view/delegated-child-opener';

/**
 * A finished task's own pull request as a compact `#N` link on the summary line's right edge, under the cost and
 * elapsed columns, so the row stays two lines tall. It is the button's sibling, absolutely placed, because a link
 * nested inside the row's button would be invalid interactive content. The trailing columns reserve its width
 * (`min-w-14`). Shows nothing when the task has no pull request or reports the delegating Session's own
 * (`delegatedOwnPullRequest`). Mounted only for a completed row, so a row still working does not subscribe to the pull
 * request snapshot.
 */
function DelegatedPullRequestLink({
    parentSessionId,
    sessionId,
}: {
    parentSessionId: string;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const { pullRequest: child } = useSessionPullRequest(sessionId);
    const { pullRequest: parent } = useSessionPullRequest(parentSessionId);
    const pullRequest = delegatedOwnPullRequest(child, parent);
    if (!pullRequest) return null;
    const label = [
        t('delegation.strip.openPullRequest', { number: pullRequest.number }),
        delegationPrFilesLabel(pullRequest.changedFiles, t),
    ]
        .filter(Boolean)
        .join(' · ');
    return (
        <Tooltip content={label}>
            <button
                aria-label={label}
                className="absolute top-[22px] right-[30px] flex h-5 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[12px] leading-5 text-accent tabular-nums underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={() => {
                    // openExternalUrl reports its own rejection through the callback.
                    void openExternalUrl(pullRequest.url, (message) => pushToast('error', message));
                }}
            >
                <SessionPullRequestIndicator pullRequest={pullRequest} />
                {`#${pullRequest.number}`}
            </button>
        </Tooltip>
    );
}

/**
 * The row's visible content: the Agent, title, Project, attempt, the status or summary line, elapsed time, and glyph.
 */
function DelegatedSessionRowContent({
    attempt,
    cost,
    entry,
    isPresetDetailVisible,
    projectTitle,
    title,
    viaTitle,
}: {
    attempt?: number;
    cost?: DelegatedCostLabel;
    entry: AgentDelegationSession;
    /**
     * Prints the preset's provider, model and effort in the row, for a row with no tooltip to carry them.
     */
    isPresetDetailVisible: boolean;
    projectTitle?: string;
    title: string;
    /**
     * The direct child a deeper row sits under, titled; absent for a direct child.
     */
    viaTitle?: string;
}) {
    const { t } = useTranslation();
    const copyInput = delegationCopyInput(entry);
    // A minute tick ages the elapsed label of a running task and expires a reset time. Mounted here, in the row, so the
    // section and its siblings stay still; a settled task with no reset or retry time reads no clock at all.
    const now = useClockTick(
        'minute',
        entry.settledAt === undefined || isDelegationCopyClockDependent(copyInput),
    );
    const copy = delegationCopy(copyInput, now, t);
    const line = delegatedSessionLine(entry, copy);
    const elapsed = formatNoticeableDuration(delegationElapsedMs(entry, now), t);
    return (
        <>
            <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                <AgentIdentityIcon identity={entry.provider} size={14} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col text-left">
                <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate text-foreground">{title}</span>
                    {projectTitle && (
                        <span className="min-w-0 shrink truncate">{projectTitle}</span>
                    )}
                    <DelegationPresetChip
                        isDetailVisible={isPresetDetailVisible}
                        selection={entry.selection}
                    />
                    {attempt !== undefined && (
                        <span className="shrink-0">
                            {t('delegation.retry.attempt', { number: attempt })}
                        </span>
                    )}
                    {viaTitle !== undefined && (
                        <span className="min-w-0 shrink truncate">
                            {t('delegation.strip.via', { title: viaTitle })}
                        </span>
                    )}
                </span>
                <span
                    className={cn('min-w-0 truncate', line.kind === 'step' && 'activity-shimmer')}
                >
                    {line.kind === 'summary' && line.isExcerpt && (
                        <span className="mr-1 rounded-sm bg-list-hover-background px-1 text-[11px]">
                            {t('delegation.strip.excerpt')}
                        </span>
                    )}
                    {line.text}
                    {line.kind === 'status' && line.detail && ` · ${line.detail}`}
                </span>
            </span>
            {/* A completed row reserves the width its pull request link takes on the line below. */}
            <span
                className={cn(
                    'flex shrink-0 justify-end gap-2 tabular-nums',
                    entry.status === 'completed' && 'min-w-14',
                )}
            >
                {cost && (
                    <span>
                        <span aria-hidden="true">{cost.text}</span>
                        <span className="sr-only">{cost.description}</span>
                    </span>
                )}
                {elapsed && <span>{elapsed}</span>}
            </span>
            <AgentChatDelegationGlyph glyph={copy.glyph} label={copy.headline} />
        </>
    );
}

const ROW_CLASS_NAME =
    'flex w-full min-w-0 items-start gap-2 rounded px-2 py-0.5 text-[12px] leading-5 text-muted';

/**
 * One child Session in the Delegated Sessions strip: the Agent, the child's title and Project, what it is doing or what
 * it produced, how long it ran, and the state glyph. The whole row opens the child; its own pull request link sits on
 * the summary line's right edge and a failed task's Retry action sits under it, each as its own control. The button has
 * no `aria-label` of its own: its content (title, Project, step or summary, elapsed time, and the glyph's label) names
 * it, so assistive technology hears what a sighted user reads. A child the Workbench no longer lists (deleted, or in a
 * hidden Project), or a failed one that never launched a Terminal, stays as a plain row.
 */
export function AgentChatDelegatedSessionRow({
    attempt,
    cost,
    entry,
    parentSessionId,
    viaSessionId,
}: {
    /**
     * Which attempt this task is when it retries a failed one (2 or more); `undefined` for a first attempt.
     */
    attempt?: number;
    /**
     * What the child's work cost, as an estimate (`delegatedCostLabel`); absent when it has no usage yet.
     */
    cost?: DelegatedCostLabel;
    entry: AgentDelegationSession;
    /**
     * The Session whose Chat shows the strip; a task's pull request that is also this Session's is not repeated.
     */
    parentSessionId?: string;
    /**
     * The direct child this row sits under, for a deeper Session the roll-up lists; absent for a direct child.
     */
    viaSessionId?: string;
}) {
    const { t } = useTranslation();
    const session = useSessionById(entry.sessionId);
    const viaSession = useSessionById(viaSessionId);
    const project = useProjectById(session?.projectId);
    const isOpenable = useCanOpenDelegatedChild(entry.sessionId, entry.status === 'failed');
    const title = session
        ? sessionTitleForDisplay(session.title, t)
        : t('delegation.strip.unavailable');
    const presetSummary = delegationPresetSummary(entry.selection, t);
    const content = (
        <DelegatedSessionRowContent
            attempt={attempt}
            cost={cost}
            entry={entry}
            isPresetDetailVisible={!session}
            projectTitle={project?.title}
            title={title}
            viaTitle={
                viaSessionId === undefined
                    ? undefined
                    : viaSession
                      ? sessionTitleForDisplay(viaSession.title, t)
                      : t('delegation.strip.unavailable')
            }
        />
    );
    return (
        <li
            className="relative flex min-w-0 flex-col"
            data-agent-chat-delegated-session={entry.sessionId}
        >
            {isOpenable ? (
                <Tooltip content={presetSummary} disabled={presetSummary === undefined}>
                    <button
                        className={cn(
                            ROW_CLASS_NAME,
                            'cursor-pointer border-0 bg-transparent hover:bg-list-hover-background hover:text-list-hover-foreground focus-visible:outline focus-visible:outline-accent',
                        )}
                        type="button"
                        onClick={() => openDelegatedChild(entry.sessionId)}
                    >
                        {content}
                    </button>
                </Tooltip>
            ) : (
                <div className={ROW_CLASS_NAME}>{content}</div>
            )}
            {entry.status === 'completed' && session && parentSessionId && (
                <DelegatedPullRequestLink
                    parentSessionId={parentSessionId}
                    sessionId={entry.sessionId}
                />
            )}
            {session && (
                <DelegationRetryControls
                    className="pl-8 leading-5"
                    entry={entry}
                    projectId={session.projectId}
                    projectTitle={project?.title ?? ''}
                    sessionTitle={title}
                />
            )}
        </li>
    );
}
