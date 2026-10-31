import type { ReactElement } from 'react';
import { useId } from 'react';

import type {
    ProjectRecord,
    PullRequestUnavailable,
    SessionPullRequest,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';

import { useRelativeTime } from '@/hooks/use-relative-time';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../components/ui/hover-card';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { isRestoringPickerFocus } from '../../lib/picker-final-focus';
import { cn } from '../../lib/utilities';
import { sessionTitleForDisplay } from '../session/session-title';
import { pullRequestUnavailableHint } from '../status-bar/pull-request-status-label';
import { useSidebarDetailCard } from './hooks/use-sidebar-detail-card';
import { ProjectIcon } from './project-icon';
import {
    currentSessionActivityPresentation,
    sessionActivityPresentation,
} from './session-activity';
import { SessionCardMetrics } from './session-card-metrics';
import { SessionCardPullRequest } from './session-card-pull-request';
import { sessionCardStatusLine } from './session-card-status';
import { sessionPullRequestPresentation } from './session-pull-request';

/**
 * The only subscriber to the shared relative-time clock on the card. The label is rendered here instead of in the card
 * so a half-minute tick re-renders this text node, not the card, its hover content, and its children.
 */
function LastActiveText({ sentence, timestamp }: { sentence?: boolean; timestamp: number }) {
    const { t } = useTranslation();
    const lastActive = useRelativeTime(timestamp);
    return sentence
        ? t('primarySidebar.card.lastActiveSentence', { time: lastActive })
        : lastActive;
}

/**
 * The row's accessible description up to (not including) the last-active and unread sentences, which the card appends
 * itself so the live relative-time clock stays out of its render.
 */
function sessionCardDescription(
    t: ReturnType<typeof useTranslation>['t'],
    parts: {
        activityLabel: string | undefined;
        agentLabel: string;
        inPinnedGroup: boolean | undefined;
        project: Pick<ProjectRecord, 'title'>;
        pullRequestLabel: string | undefined;
        pullRequestUnavailable: PullRequestUnavailable | undefined;
        worktreeProject: ProjectRecord | undefined;
    },
): string {
    return [
        // The pin has no visible mark on the row itself (it is the group the row sits in) and a pinned Session is
        // listed only there, so this sentence is the only thing that says the row is pinned at all.
        parts.inPinnedGroup && t('primarySidebar.card.inPinnedGroup'),
        t('primarySidebar.card.projectSentence', { title: parts.project.title }),
        t('primarySidebar.card.agentSentence', { agent: parts.agentLabel }),
        parts.activityLabel,
        !parts.pullRequestUnavailable && parts.pullRequestLabel,
        parts.pullRequestUnavailable &&
            t('primarySidebar.card.pullRequestUnknown', {
                hint: pullRequestUnavailableHint(parts.pullRequestUnavailable, t),
            }),
        parts.worktreeProject &&
            t('primarySidebar.card.worktreeSentence', {
                title: parts.worktreeProject.title,
            }),
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
    project: Pick<ProjectRecord, 'title' | 'icon'>;
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
     * Workbench Root Project when this Session works in a linked worktree. The row marker is decorative, so the row's
     * accessible description is where the fact becomes readable.
     */
    worktreeProject?: ProjectRecord;
}) {
    const accessibleDescriptionId = useId();
    const { t } = useTranslation();
    const { closeDelay, delay, motionClassName, onPointerEnter, setOpen, visible } =
        useSidebarDetailCard(suppressed);
    const agent = terminal?.kind ?? 'shell';
    const activity = currentSessionActivityPresentation(
        session,
        {
            agentOperation: terminal?.agentOperation,
            kind: agent,
            lastProcessState: terminal?.lastProcessState,
        },
        t,
    );
    const agentLabel = resolveAgentIcon(agent).label;
    const accessibleDescription = sessionCardDescription(t, {
        agentLabel,
        activityLabel: activity.ariaLabel,
        inPinnedGroup,
        project,
        pullRequestLabel: pullRequest
            ? sessionPullRequestPresentation(pullRequest, t).ariaLabel
            : undefined,
        pullRequestUnavailable,
        worktreeProject,
    });
    const statusLine = sessionCardStatusLine(session, terminal, t);
    // The list's status slot collapses every attention kind into one signal; the description names the exact one.
    const unreadSentence = session.hasUnread
        ? t('primarySidebar.card.sentence', {
              text: t('primarySidebar.card.unreadAttention', {
                  label: sessionActivityPresentation(
                      session.lastAttentionKind ?? 'unknown',
                      undefined,
                      t,
                  ).label,
              }),
          })
        : undefined;

    return (
        <HoverCard open={visible} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
            <HoverCardTrigger
                aria-describedby={accessibleDescriptionId}
                closeDelay={closeDelay}
                delay={delay}
                onPointerEnter={onPointerEnter}
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
                {accessibleDescription}{' '}
                <LastActiveText sentence timestamp={session.sessionActivityAt} />
                {unreadSentence ? ` ${unreadSentence}` : undefined}
            </span>
            {/*
             * A glance, after the Codex app's thread list: which Session, which Agent, how recently, which Project, and
             * the facts the row cannot show without opening the Session: its pull request, what it is running right now,
             * and what it has cost. The row hides its PR and status glyphs while hovered, so the card restates the PR
             * as its own line and a non-default status (working, unread, detached) as one muted line. The creating
             * Session and past conversations open from the row's context menu.
             */}
            <HoverCardContent
                align="start"
                className={cn(
                    'session-activity-card w-max max-w-[min(20rem,calc(100vw-16px))] px-3 py-2',
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
                <div className="flex min-w-0 items-start gap-1.5">
                    <h3 className="m-0 line-clamp-2 min-w-0 text-[13px] font-medium wrap-break-word">
                        {sessionTitleForDisplay(session.title, t)}
                    </h3>
                    <span className="mt-0.5 flex flex-none text-muted">
                        <AgentIdentityIcon identity={agent} size={14} />
                    </span>
                    <span className="session-card-time ml-auto flex-none pl-4 text-[12px] whitespace-nowrap text-muted">
                        <LastActiveText timestamp={session.sessionActivityAt} />
                    </span>
                </div>
                <p className="mt-1 mb-0 flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
                    <ProjectIcon className="flex-none" icon={project.icon} size={13} />
                    <span className="min-w-0 truncate">{project.title}</span>
                </p>
                {pullRequest && <SessionCardPullRequest pullRequest={pullRequest} />}
                <SessionCardMetrics reserveSpace={agent !== 'shell'} sessionId={session.id} />
                {statusLine && (
                    <p className="mt-1 mb-0 min-w-0 truncate text-[12px] text-muted">
                        {statusLine}
                    </p>
                )}
            </HoverCardContent>
        </HoverCard>
    );
}
