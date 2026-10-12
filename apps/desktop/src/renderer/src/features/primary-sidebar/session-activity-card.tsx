import type { ReactElement } from 'react';
import { useEffect, useId, useState } from 'react';

import type {
    ProjectRecord,
    PullRequestUnavailable,
    SessionPullRequest,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { Circle } from 'lucide-react';

import { useRelativeTime } from '@/hooks/use-relative-time';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../components/ui/hover-card';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { isRestoringPickerFocus } from '../../lib/picker-final-focus';
import { cn } from '../../lib/utilities';
import { openSessionPullRequest } from '../session/session-commands';
import { pullRequestUnavailableLabel } from '../status-bar/pull-request-status-label';
import { useSessionChanges } from './hooks/use-session-changes';
import { ProjectIcon } from './project-icon';
import type { SessionActivityPresentation } from './session-activity';
import {
    currentSessionActivityPresentation,
    sessionActivityPresentation,
    sessionToneCalloutClassName,
    sessionUnreadTone,
} from './session-activity';
import { sessionPullRequestPresentation } from './session-pull-request';
import { SessionPullRequestIndicator } from './session-pull-request-indicator';
import { sidebarDetailCardDismissal } from './sidebar-detail-card-dismissal';

/**
 * The detail card keeps the exact attention kind and its explanatory tone even though the list's compact status slot
 * deliberately collapses every attention kind into one warning-colored "needs attention" signal.
 */
function unreadAttentionPresentation(
    session: SessionRecord,
): SessionActivityPresentation | undefined {
    if (!session.hasUnread) return undefined;
    const kind = session.lastAttentionKind ?? 'unknown';
    return { ...sessionActivityPresentation(kind), tone: sessionUnreadTone(kind) };
}

function SessionPullRequestLink({
    pullRequest,
    presentation,
}: {
    pullRequest: SessionPullRequest;
    presentation: ReturnType<typeof sessionPullRequestPresentation>;
}) {
    const { t } = useTranslation();
    return (
        <a
            className="mt-2 flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] text-foreground no-underline hover:bg-elevated"
            href={pullRequest.url}
            rel="noreferrer"
            aria-label={t('primarySidebar.card.openPullRequestAriaLabel', {
                number: pullRequest.number,
                title: pullRequest.title,
            })}
            onClick={(event) => {
                // Main denies window navigation; this semantic link uses the shared external.open action.
                event.preventDefault();
                event.stopPropagation();
                openSessionPullRequest(pullRequest);
            }}
        >
            <SessionPullRequestIndicator pullRequest={pullRequest} />
            <span className="flex-none font-medium">#{pullRequest.number}</span>
            <span className="flex-none text-muted">{presentation.label}</span>
            <span className="min-w-0 flex-1 text-muted">
                <span className="block truncate">{pullRequest.title}</span>
                {presentation.checksLabel && (
                    <span
                        className={cn(
                            'block',
                            presentation.checksTone === 'danger'
                                ? 'text-danger'
                                : presentation.checksTone === 'warning'
                                  ? 'text-warning'
                                  : 'text-muted',
                        )}
                    >
                        {presentation.checksLabel}
                    </span>
                )}
            </span>
        </a>
    );
}

function SessionPullRequestDetails({
    pullRequest,
    presentation,
    unavailable,
}: {
    pullRequest?: SessionPullRequest;
    presentation?: ReturnType<typeof sessionPullRequestPresentation>;
    unavailable?: PullRequestUnavailable;
}) {
    const { t } = useTranslation();
    if (unavailable)
        return (
            <div className="mt-2 text-[11px] leading-[1.45] text-muted">
                {/*
                 * The same named label the status-bar chip shows. A card that said `PR unknown` for all eight reasons
                 * contradicted the chip sitting on the same screen, which has named them apart since `7763bd34`.
                 */}
                <span className="font-medium">
                    {pullRequestUnavailableLabel(unavailable.reason, t)}
                </span>
                <p className="mt-0.5 mb-0">{unavailable.hint}</p>
            </div>
        );
    if (!pullRequest || !presentation) return null;
    return <SessionPullRequestLink pullRequest={pullRequest} presentation={presentation} />;
}

export function SessionActivityCard({
    inPinnedGroup,
    project,
    pullRequest,
    pullRequestUnavailable,
    session,
    suppressed = false,
    terminal,
    trigger,
    worktreeProject,
}: {
    /**
     * True on the Pinned group's copy of a doubly listed Session. Both copies otherwise announce word for word the same
     * thing (the row's accessible name is the title, and the visible Project name is `aria-hidden`) so a keyboard user
     * walking the tree could not tell which one they had reached.
     */
    inPinnedGroup?: boolean;
    /**
     * The owning Project, as the fields the card shows.
     */
    project: Pick<ProjectRecord, 'displayTitle' | 'icon'>;
    pullRequest?: SessionPullRequest;
    pullRequestUnavailable?: PullRequestUnavailable;
    session: SessionRecord;
    /**
     * Keeps the card closed while another popup (the row's context menu) owns the pointer.
     */
    suppressed?: boolean;
    terminal?: TerminalRecord;
    trigger: ReactElement;
    /**
     * Workbench Root Project when this Session works in a linked worktree. The row marker is decorative, so this card
     * is where the fact becomes readable: both as a metadata row and in the row's accessible description.
     */
    worktreeProject?: ProjectRecord;
}) {
    const accessibleDescriptionId = useId();
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const agent = terminal?.kind ?? 'shell';
    const activity = currentSessionActivityPresentation(session, {
        agentOperation: terminal?.agentOperation,
        kind: agent,
        lastProcessState: terminal?.lastProcessState,
    });
    const agentLabel = resolveAgentIcon(agent).label;
    const lastOpened = useRelativeTime(session.lastOpenedAt);
    const unreadAttention = unreadAttentionPresentation(session);
    const unread = unreadAttention
        ? t('primarySidebar.card.unreadAttention', { label: unreadAttention.label })
        : undefined;
    const pullRequestPresentation = pullRequest
        ? sessionPullRequestPresentation(pullRequest)
        : undefined;
    const visible = open && !suppressed;
    const changes = useSessionChanges(session, visible);
    const accessibleDescription = [
        // The pin has no visible mark on the row itself (it is the group the row sits in) and a pinned Session is
        // listed only there, so this sentence is the only thing that says the row is pinned at all.
        inPinnedGroup && t('primarySidebar.card.inPinnedGroup'),
        t('primarySidebar.card.projectSentence', { title: project.displayTitle }),
        t('primarySidebar.card.agentSentence', { agent: agentLabel }),
        activity.ariaLabel,
        !pullRequestUnavailable && pullRequestPresentation?.ariaLabel,
        pullRequestUnavailable &&
            t('primarySidebar.card.pullRequestUnknown', { hint: pullRequestUnavailable.hint }),
        worktreeProject &&
            t('primarySidebar.card.worktreeSentence', { title: worktreeProject.displayTitle }),
        changes?.ariaLabel,
        t('primarySidebar.card.lastOpenedSentence', { time: lastOpened }),
        unread ? t('primarySidebar.card.sentence', { text: unread }) : undefined,
    ]
        .filter(Boolean)
        .join(' ');

    useEffect(() => {
        if (!visible) return;
        return sidebarDetailCardDismissal(() => setOpen(false));
    }, [visible]);

    return (
        <HoverCard open={visible} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
            <HoverCardTrigger
                aria-describedby={accessibleDescriptionId}
                closeDelay={80}
                delay={450}
                onFocus={(event) => {
                    event.preventBaseUIHandler();
                    setOpen(
                        event.currentTarget.matches(':focus-visible') &&
                            !isRestoringPickerFocus(event.currentTarget),
                    );
                }}
                render={trigger}
            />
            <span id={accessibleDescriptionId} className="sr-only">
                {accessibleDescription}
            </span>
            <HoverCardContent
                align="start"
                className="session-activity-card w-72 max-w-[calc(100vw-16px)] p-3"
                collisionAvoidance={{ align: 'shift', fallbackAxisSide: 'end', side: 'flip' }}
                collisionBoundary={document.documentElement}
                collisionPadding={8}
                positionMethod="fixed"
                role="tooltip"
                side="right"
                sideOffset={8}
            >
                <div className="flex min-w-0 items-start gap-2">
                    <AgentIdentityIcon identity={agent} size={17} />
                    <div className="min-w-0 flex-1">
                        <h3 className="m-0 text-[13px] font-semibold wrap-break-word">
                            {session.displayTitle}
                        </h3>
                        <p className="mt-0.5 mb-0 flex items-center gap-1 truncate text-[11px] text-muted">
                            <ProjectIcon icon={project.icon} size={11} />
                            <span className="truncate">
                                {project.displayTitle} · {agentLabel}
                            </span>
                        </p>
                    </div>
                </div>
                <div className="mt-3 rounded-md border border-border bg-surface p-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium">
                        <Circle
                            aria-hidden="true"
                            className={cn('flex-none', activity.indicatorClassName)}
                            fill="currentColor"
                            size={7}
                        />
                        <span>{activity.label}</span>
                    </div>
                    <p className="mt-1 mb-0 text-[11px] leading-[1.45] text-muted">
                        {activity.description}
                    </p>
                </div>
                <SessionPullRequestDetails
                    pullRequest={pullRequest}
                    presentation={pullRequestPresentation}
                    unavailable={pullRequestUnavailable}
                />
                {worktreeProject && (
                    <div className="session-card-worktree mt-2 flex items-center justify-between gap-3 text-[11px] text-muted">
                        <span className="flex-none">{t('primarySidebar.card.worktree')}</span>
                        <span className="min-w-0 truncate text-right text-foreground">
                            {worktreeProject.displayTitle}
                        </span>
                    </div>
                )}
                {changes && (
                    <div className="session-card-changes mt-2 flex items-center justify-between gap-3 text-[11px] text-muted">
                        <span className="flex-none">{t('primarySidebar.card.changes')}</span>
                        <span className="text-right text-foreground tabular-nums">
                            {changes.value}
                        </span>
                    </div>
                )}
                <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted">
                    <span>{t('primarySidebar.card.lastOpened')}</span>
                    <span className="text-right text-foreground">{lastOpened}</span>
                </div>
                {unread && unreadAttention && (
                    <p
                        className={cn(
                            'mt-2 mb-0 rounded px-2 py-1.5 text-[11px]',
                            sessionToneCalloutClassName(unreadAttention.tone),
                        )}
                    >
                        {unread}
                    </p>
                )}
            </HoverCardContent>
        </HoverCard>
    );
}
