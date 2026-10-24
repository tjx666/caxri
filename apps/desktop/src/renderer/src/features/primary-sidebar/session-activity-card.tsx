import type { ReactElement } from 'react';
import { useId } from 'react';

import type {
    ProjectRecord,
    PullRequestUnavailable,
    SessionPullRequest,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { Circle, GitBranch } from 'lucide-react';

import { useRelativeTime } from '@/hooks/use-relative-time';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../components/ui/hover-card';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { isRestoringPickerFocus } from '../../lib/picker-final-focus';
import { cn } from '../../lib/utilities';
import { openSessionPullRequest } from '../session/session-commands';
import { sessionTitleForDisplay } from '../session/session-title';
import { pullRequestUnavailableLabel } from '../status-bar/pull-request-status-label';
import { useSessionChanges } from './hooks/use-session-changes';
import { useSidebarDetailCard } from './hooks/use-sidebar-detail-card';
import { ProjectIcon } from './project-icon';
import type { SessionActivityPresentation } from './session-activity';
import {
    currentSessionActivityPresentation,
    sessionActivityPresentation,
    sessionToneCalloutClassName,
    sessionUnreadTone,
} from './session-activity';
import { SessionCreatorRow } from './session-creator-row';
import { SessionExcerpt } from './session-excerpt';
import { sessionPullRequestPresentation } from './session-pull-request';
import { SessionPullRequestIndicator } from './session-pull-request-indicator';

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
            className="-mx-1.5 mt-1.5 flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-foreground no-underline hover:bg-state-hover"
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
            <span className="flex-none font-medium tabular-nums">#{pullRequest.number}</span>
            <span className="min-w-0 flex-1 truncate text-muted">{pullRequest.title}</span>
            {/*
             * The glyph already colors the lifecycle, so an open PR spends this slot on its checks and every other
             * state names itself (Draft, Merged, Deployed) where the glyph alone is ambiguous.
             */}
            <span
                className={cn(
                    'flex-none',
                    presentation.checksTone === 'danger'
                        ? 'text-danger'
                        : presentation.checksTone === 'warning'
                          ? 'text-warning'
                          : 'text-muted',
                )}
            >
                {presentation.checksLabel ?? presentation.label}
            </span>
        </a>
    );
}

/**
 * The only subscriber to the shared relative-time clock on the card. The label is rendered here instead of in the card
 * so a half-minute tick re-renders this text node, not the card, its hover content, and its children.
 */
function LastOpenedText({ sentence, timestamp }: { sentence?: boolean; timestamp: number }) {
    const { t } = useTranslation();
    const lastOpened = useRelativeTime(timestamp);
    return t(
        sentence ? 'primarySidebar.card.lastOpenedSentence' : 'primarySidebar.card.openedAgo',
        { time: lastOpened },
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

/**
 * The row's accessible description up to (not including) the last-opened and unread sentences, which the card appends
 * itself so the live relative-time clock stays out of its render.
 */
function sessionCardDescription(
    t: ReturnType<typeof useTranslation>['t'],
    parts: {
        activityLabel: string | undefined;
        agentLabel: string;
        changesLabel: string | undefined;
        inPinnedGroup: boolean | undefined;
        project: Pick<ProjectRecord, 'displayTitle'>;
        pullRequestLabel: string | undefined;
        pullRequestUnavailable: PullRequestUnavailable | undefined;
        worktreeProject: ProjectRecord | undefined;
    },
): string {
    return [
        // The pin has no visible mark on the row itself (it is the group the row sits in) and a pinned Session is
        // listed only there, so this sentence is the only thing that says the row is pinned at all.
        parts.inPinnedGroup && t('primarySidebar.card.inPinnedGroup'),
        t('primarySidebar.card.projectSentence', { title: parts.project.displayTitle }),
        t('primarySidebar.card.agentSentence', { agent: parts.agentLabel }),
        parts.activityLabel,
        !parts.pullRequestUnavailable && parts.pullRequestLabel,
        parts.pullRequestUnavailable &&
            t('primarySidebar.card.pullRequestUnknown', {
                hint: parts.pullRequestUnavailable.hint,
            }),
        parts.worktreeProject &&
            t('primarySidebar.card.worktreeSentence', {
                title: parts.worktreeProject.displayTitle,
            }),
        parts.changesLabel,
    ]
        .filter(Boolean)
        .join(' ');
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
    const { closeDelay, delay, motionClassName, setOpen, visible } =
        useSidebarDetailCard(suppressed);
    const agent = terminal?.kind ?? 'shell';
    const activity = currentSessionActivityPresentation(session, {
        agentOperation: terminal?.agentOperation,
        kind: agent,
        lastProcessState: terminal?.lastProcessState,
    });
    const agentLabel = resolveAgentIcon(agent).label;
    const unreadAttention = unreadAttentionPresentation(session);
    const unread = unreadAttention
        ? t('primarySidebar.card.unreadAttention', { label: unreadAttention.label })
        : undefined;
    const pullRequestPresentation = pullRequest
        ? sessionPullRequestPresentation(pullRequest)
        : undefined;
    const changes = useSessionChanges(session, visible);
    const accessibleDescription = sessionCardDescription(t, {
        agentLabel,
        activityLabel: activity.ariaLabel,
        changesLabel: changes?.ariaLabel,
        inPinnedGroup,
        project,
        pullRequestLabel: pullRequestPresentation?.ariaLabel,
        pullRequestUnavailable,
        worktreeProject,
    });
    const unreadSentence = unread ? t('primarySidebar.card.sentence', { text: unread }) : undefined;

    return (
        <HoverCard open={visible} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
            <HoverCardTrigger
                aria-describedby={accessibleDescriptionId}
                closeDelay={closeDelay}
                delay={delay}
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
                {accessibleDescription} <LastOpenedText sentence timestamp={session.lastOpenedAt} />
                {unreadSentence ? ` ${unreadSentence}` : undefined}
            </span>
            <HoverCardContent
                align="start"
                className={cn(
                    'session-activity-card w-72 max-w-[calc(100vw-16px)] p-3',
                    motionClassName,
                )}
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
                            {sessionTitleForDisplay(session.displayTitle, t)}
                        </h3>
                        <p className="mt-0.5 mb-0 flex min-w-0 items-center gap-1 text-[11px] text-muted">
                            <ProjectIcon icon={project.icon} size={11} />
                            <span className="min-w-0 truncate">
                                {project.displayTitle} · {agentLabel}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="session-card-activity flex flex-none items-center gap-1 text-foreground">
                                <Circle
                                    aria-hidden="true"
                                    className={cn('flex-none', activity.indicatorClassName)}
                                    fill="currentColor"
                                    size={7}
                                />
                                {activity.label}
                            </span>
                        </p>
                    </div>
                </div>
                {activity.hasVisibleDescription && (
                    <p className="mt-2 mb-0 text-[11px] leading-[1.45] text-muted">
                        {activity.description}
                    </p>
                )}
                <SessionExcerpt isVisible={visible} session={session} />
                <SessionPullRequestDetails
                    pullRequest={pullRequest}
                    presentation={pullRequestPresentation}
                    unavailable={pullRequestUnavailable}
                />
                {session.createdBySessionId && <SessionCreatorRow session={session} />}
                {/*
                 * Secondary facts share one muted footer line instead of a labeled row each. The worktree name
                 * truncates first; the change count and last-opened time keep their width.
                 */}
                <div className="mt-2.5 flex min-w-0 items-center gap-3 border-t border-border pt-2 text-[11px] text-muted">
                    {worktreeProject && (
                        <span className="session-card-worktree flex min-w-0 items-center gap-1">
                            <GitBranch aria-hidden="true" className="flex-none" size={11} />
                            <span className="truncate">{worktreeProject.displayTitle}</span>
                        </span>
                    )}
                    <span className="ml-auto flex flex-none items-center gap-2">
                        {changes && (
                            <span className="session-card-changes tabular-nums">
                                {changes.value}
                            </span>
                        )}
                        <span>
                            <LastOpenedText timestamp={session.lastOpenedAt} />
                        </span>
                    </span>
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
