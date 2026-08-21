import type { ReactElement } from 'react';
import { useEffect, useId, useState } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@shared/types';
import { Circle } from 'lucide-react';

import { useNow } from '@/hooks/use-now';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../components/ui/hover-card';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import { ProjectIcon } from './project-icon';
import type { SessionActivityPresentation } from './session-activity';
import {
    formatSessionRelativeTime,
    sessionActivityPresentation,
    sessionToneCalloutClassName,
    sessionUnreadTone,
} from './session-activity';

/**
 * Reuses the same tone table as the activity dot and the Sidebar ring, per the single source of truth.
 *
 * The chip keeps the exact attention kind in its label but takes its tone from `sessionUnreadTone`, so the card matches
 * the ring that opened it — an unread Session must not read as a warning in the Sidebar and as inert grey in its own
 * hover card.
 */
function unreadAttentionPresentation(
    session: SessionRecord,
): SessionActivityPresentation | undefined {
    if (!session.hasUnread) return undefined;
    const kind = session.lastAttentionKind ?? 'unknown';
    return { ...sessionActivityPresentation(kind), tone: sessionUnreadTone(kind) };
}

export function SessionActivityCard({
    project,
    session,
    terminal,
    trigger,
}: {
    project: ProjectRecord;
    session: SessionRecord;
    terminal?: TerminalRecord;
    trigger: ReactElement;
}) {
    const accessibleDescriptionId = useId();
    const [open, setOpen] = useState(false);
    const now = useNow(30_000);
    const activity = sessionActivityPresentation(
        session.lastActivityState,
        terminal?.agentOperation,
    );
    const agent = terminal?.kind ?? 'shell';
    const agentLabel = resolveAgentIcon(agent).label;
    const lastOpened = formatSessionRelativeTime(session.lastOpenedAt, now);
    const unreadAttention = unreadAttentionPresentation(session);
    const unread = unreadAttention ? `Unread attention: ${unreadAttention.label}` : undefined;
    const accessibleDescription = [
        `Project ${project.displayTitle}.`,
        `Agent ${agentLabel}.`,
        activity.ariaLabel,
        `Last opened ${lastOpened}.`,
        unread ? `${unread}.` : undefined,
    ]
        .filter(Boolean)
        .join(' ');

    useEffect(() => {
        if (!open) return;
        /**
         * Xterm consumes Escape before React's popup handler sees it, so capture it at Window.
         */
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
        };
        addEventListener('keydown', closeOnEscape, { capture: true });
        return () => removeEventListener('keydown', closeOnEscape, { capture: true });
    }, [open]);

    return (
        <HoverCard open={open} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
            <HoverCardTrigger
                aria-describedby={accessibleDescriptionId}
                closeDelay={80}
                delay={450}
                onFocus={(event) => {
                    if (!event.currentTarget.matches(':focus-visible')) return;
                    event.preventBaseUIHandler();
                    setOpen(true);
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
