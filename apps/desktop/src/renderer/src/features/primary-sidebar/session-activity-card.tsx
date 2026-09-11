import type { ReactElement } from 'react';
import { useEffect, useId, useState } from 'react';

import type {
    ProjectRecord,
    SessionPullRequest,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { Circle } from 'lucide-react';

import { useNow } from '@/hooks/use-now';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../components/ui/hover-card';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { openExternalUrl } from '../../lib/external-link';
import { isRestoringPickerFocus } from '../../lib/picker-final-focus';
import { cn } from '../../lib/utilities';
import { pushToast } from '../../stores/toasts';
import { ProjectIcon } from './project-icon';
import type { SessionActivityPresentation } from './session-activity';
import {
    formatSessionRelativeTime,
    sessionActivityPresentation,
    sessionToneCalloutClassName,
    sessionUnreadTone,
} from './session-activity';
import { sessionActivityCardDismissal } from './session-activity-card-dismissal';
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

/**
 * A detached Agent was stopped on purpose so another client can resume it; the last probed lifecycle state would
 * misreport it as still working or waiting here.
 */
const detachedActivityPresentation = {
    ariaLabel: 'Detached. The Agent was stopped so another client can resume it.',
    description:
        'Stopped so another client can resume this conversation. Resume it from the row menu.',
    indicatorClassName: 'text-muted',
    label: 'Detached',
    tone: 'neutral',
} satisfies ReturnType<typeof sessionActivityPresentation>;

function SessionPullRequestDetails({ pullRequest }: { pullRequest: SessionPullRequest }) {
    const presentation = sessionPullRequestPresentation(pullRequest);
    return (
        <a
            className="mt-2 flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] text-foreground no-underline hover:bg-elevated"
            href={pullRequest.url}
            rel="noreferrer"
            aria-label={`Open pull request #${pullRequest.number}: ${pullRequest.title}`}
            onClick={(event) => {
                // Main denies window.open navigation; use the structured external.open boundary.
                event.preventDefault();
                event.stopPropagation();
                // eslint-disable-next-line no-void -- intentional floating-promise discard, openExternalUrl reports its own failure
                void openExternalUrl(pullRequest.url, (message) => pushToast('error', message));
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

export function SessionActivityCard({
    project,
    pullRequest,
    session,
    suppressed = false,
    terminal,
    trigger,
    worktreeProject,
}: {
    project: ProjectRecord;
    pullRequest?: SessionPullRequest;
    session: SessionRecord;
    /**
     * Keeps the card closed while another popup (the row's context menu) owns the pointer.
     */
    suppressed?: boolean;
    terminal?: TerminalRecord;
    trigger: ReactElement;
    /**
     * Workbench Root Project when this Session works in a linked worktree. The row marker is decorative, so this card
     * is where the fact becomes readable — both as a metadata row and in the row's accessible description.
     */
    worktreeProject?: ProjectRecord;
}) {
    const accessibleDescriptionId = useId();
    const [open, setOpen] = useState(false);
    const now = useNow(30_000);
    const activity =
        terminal?.lastProcessState === 'detached'
            ? detachedActivityPresentation
            : sessionActivityPresentation(session.lastActivityState, terminal?.agentOperation);
    const agent = terminal?.kind ?? 'shell';
    const agentLabel = resolveAgentIcon(agent).label;
    const lastOpened = formatSessionRelativeTime(session.lastOpenedAt, now);
    const unreadAttention = unreadAttentionPresentation(session);
    const unread = unreadAttention ? `Unread attention: ${unreadAttention.label}` : undefined;
    const pullRequestPresentation = pullRequest
        ? sessionPullRequestPresentation(pullRequest)
        : undefined;
    const accessibleDescription = [
        `Project ${project.displayTitle}.`,
        `Agent ${agentLabel}.`,
        activity.ariaLabel,
        pullRequestPresentation?.ariaLabel,
        worktreeProject && `Working in worktree ${worktreeProject.displayTitle}.`,
        `Last opened ${lastOpened}.`,
        unread ? `${unread}.` : undefined,
    ]
        .filter(Boolean)
        .join(' ');

    useEffect(() => {
        if (!open) return;
        return sessionActivityCardDismissal(() => setOpen(false));
    }, [open]);

    return (
        <HoverCard open={open && !suppressed} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
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
                        <p className="mt-0.5 mb-0 flex items-center gap-1 truncate text-[10px] text-muted">
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
                    <p className="mt-1 mb-0 text-[10px] leading-[1.45] text-muted">
                        {activity.description}
                    </p>
                </div>
                {pullRequest && <SessionPullRequestDetails pullRequest={pullRequest} />}
                {worktreeProject && (
                    <div className="session-card-worktree mt-2 flex items-center justify-between gap-3 text-[10px] text-muted">
                        <span className="flex-none">Worktree</span>
                        <span className="min-w-0 truncate text-right text-foreground">
                            {worktreeProject.displayTitle}
                        </span>
                    </div>
                )}
                <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-muted">
                    <span>Last opened</span>
                    <span className="text-right text-foreground">{lastOpened}</span>
                </div>
                {unread && unreadAttention && (
                    <p
                        className={cn(
                            'mt-2 mb-0 rounded px-2 py-1.5 text-[10px]',
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
