import type { AgentDelegationSession } from '@caxri/protocol';
import { formatNoticeableDuration } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';
import { openExternalUrl } from '../../../lib/external-link';
import { cn } from '../../../lib/utilities';
import { useProjectById, useSessionById } from '../../../stores/selectors';
import { pushToast } from '../../../stores/toasts';
import { delegationCopy, delegationCopyInput } from '../../delegation/delegation-copy';
import { delegationElapsedMs } from '../../delegation/delegation-feed';
import { DelegationRetryControls } from '../../delegation/delegation-retry-controls';
import { useSessionPullRequest } from '../../primary-sidebar/hooks/use-session-pull-request';
import { SessionPullRequestIndicator } from '../../primary-sidebar/session-pull-request-indicator';
import { openSession } from '../../session/session-commands';
import { sessionTitleForDisplay } from '../../session/session-title';
import { delegatedSessionLine, delegationPrFilesLabel } from './agent-chat-delegated-sessions';
import { AgentChatDelegationGlyph } from './agent-chat-delegation-glyph';

/**
 * A finished task's pull request, with the whole pull request's file count. Mounted only for a completed row, so a row
 * that is still working does not subscribe to the pull request snapshot. Shows nothing without a discovered pull
 * request; the file count is left out when GitHub reported none.
 */
function DelegatedResultMeta({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const { pullRequest } = useSessionPullRequest(sessionId);
    if (!pullRequest) return null;
    const files = delegationPrFilesLabel(pullRequest.changedFiles, t);
    return (
        <span className="flex min-w-0 items-center gap-1.5 pl-8 text-[12px] leading-5 text-muted">
            <SessionPullRequestIndicator pullRequest={pullRequest} />
            <button
                className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-[12px] text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={() => {
                    // openExternalUrl reports its own rejection through the callback.
                    void openExternalUrl(pullRequest.url, (message) => pushToast('error', message));
                }}
            >
                {t('delegation.strip.openPullRequest', { number: pullRequest.number })}
            </button>
            {files && <span className="shrink-0 tabular-nums">{files}</span>}
        </span>
    );
}

/**
 * The row's visible content: the Agent, title, Project, attempt, the status or summary line, elapsed time, and glyph.
 */
function DelegatedSessionRowContent({
    attempt,
    entry,
    now,
    projectTitle,
    title,
}: {
    attempt?: number;
    entry: AgentDelegationSession;
    now: number;
    projectTitle?: string;
    title: string;
}) {
    const { t } = useTranslation();
    const copy = delegationCopy(delegationCopyInput(entry), now, t);
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
                    {attempt !== undefined && (
                        <span className="shrink-0">
                            {t('delegation.retry.attempt', { number: attempt })}
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
            {elapsed && <span className="shrink-0 tabular-nums">{elapsed}</span>}
            <AgentChatDelegationGlyph glyph={copy.glyph} label={copy.headline} />
        </>
    );
}

const ROW_CLASS_NAME =
    'flex w-full min-w-0 items-start gap-2 rounded px-2 py-0.5 text-[12px] leading-5 text-muted';

/**
 * One child Session in the Delegated Sessions strip: the Agent, the child's title and Project, what it is doing or what
 * it produced, how long it ran, and the state glyph. The whole row opens the child; a pull request link sits under it
 * and a failed task's Retry action sit under it as their own controls. The button has no `aria-label` of its own: its
 * content (title, Project, step or summary, elapsed time, and the glyph's label) names it, so assistive technology
 * hears what a sighted user reads. A child the Workbench no longer lists (deleted, or in a hidden Project) stays as a
 * plain row.
 */
export function AgentChatDelegatedSessionRow({
    attempt,
    entry,
    now,
}: {
    /**
     * Which attempt this task is when it retries a failed one (2 or more); `undefined` for a first attempt.
     */
    attempt?: number;
    entry: AgentDelegationSession;
    now: number;
}) {
    const { t } = useTranslation();
    const session = useSessionById(entry.sessionId);
    const project = useProjectById(session?.projectId);
    const title = session
        ? sessionTitleForDisplay(session.title, t)
        : t('delegation.strip.unavailable');
    const content = (
        <DelegatedSessionRowContent
            attempt={attempt}
            entry={entry}
            now={now}
            projectTitle={project?.title}
            title={title}
        />
    );
    return (
        <li className="flex min-w-0 flex-col" data-agent-chat-delegated-session={entry.sessionId}>
            {session ? (
                <button
                    className={cn(
                        ROW_CLASS_NAME,
                        'cursor-pointer border-0 bg-transparent hover:bg-list-hover-background hover:text-list-hover-foreground focus-visible:outline focus-visible:outline-accent',
                    )}
                    type="button"
                    onClick={() => openSession(entry.sessionId)}
                >
                    {content}
                </button>
            ) : (
                <div className={ROW_CLASS_NAME}>{content}</div>
            )}
            {entry.status === 'completed' && session && (
                <DelegatedResultMeta sessionId={entry.sessionId} />
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
