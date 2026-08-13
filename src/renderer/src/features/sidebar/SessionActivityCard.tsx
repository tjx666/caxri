import { PreviewCard } from '@base-ui/react/preview-card';
import { Circle } from 'lucide-react';
import { useEffect, useId, useState, type ReactElement } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@shared/types';

import { AgentIdentityIcon } from '../../icons/agents/AgentIdentityIcon';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { cn } from '../../lib/utils';
import {
    formatSessionRelativeTime,
    sessionActivityPresentation,
    sessionToneCalloutClassName,
    type SessionActivityPresentation,
} from './session-activity';

/** Reuses the same tone table as the activity dot and the Sidebar ring, per the single source of truth. */
function unreadAttentionPresentation(
    session: SessionRecord,
): SessionActivityPresentation | undefined {
    if (!session.hasUnread) return undefined;
    return sessionActivityPresentation(session.lastAttentionKind ?? 'unknown');
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
    const activity = sessionActivityPresentation(session.lastActivityState);
    const agent = terminal?.kind ?? 'shell';
    const agentLabel = resolveAgentIcon(agent).label;
    const lastOpened = formatSessionRelativeTime(session.lastOpenedAt);
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
        /** xterm consumes Escape before React's popup handler sees it, so capture it at Window. */
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
        };
        window.addEventListener('keydown', closeOnEscape, { capture: true });
        return () => window.removeEventListener('keydown', closeOnEscape, { capture: true });
    }, [open]);

    return (
        <PreviewCard.Root open={open} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
            <PreviewCard.Trigger
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
            <PreviewCard.Portal>
                <PreviewCard.Positioner
                    align="start"
                    className="session-activity-card-positioner z-[80]"
                    collisionAvoidance={{ align: 'shift', fallbackAxisSide: 'end', side: 'flip' }}
                    collisionBoundary={document.documentElement}
                    collisionPadding={8}
                    positionMethod="fixed"
                    side="right"
                    sideOffset={8}
                >
                    <PreviewCard.Popup
                        className={cn(
                            'session-activity-card w-72 max-w-[calc(100vw-16px)] rounded-lg border border-border bg-elevated p-3 text-foreground shadow-[0_12px_32px_var(--shadow)] outline-none',
                            'origin-(--transform-origin)',
                            'motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
                            'duration-(--motion-overlay-enter) data-closed:duration-(--motion-overlay-exit)',
                        )}
                        role="tooltip"
                    >
                        <div className="flex min-w-0 items-start gap-2">
                            <AgentIdentityIcon identity={agent} size={17} />
                            <div className="min-w-0 flex-1">
                                <h3 className="m-0 wrap-break-word text-[13px] font-semibold">
                                    {session.displayTitle}
                                </h3>
                                <p className="mt-0.5 mb-0 truncate text-[10px] text-muted">
                                    {project.displayTitle} · {agentLabel}
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
                    </PreviewCard.Popup>
                </PreviewCard.Positioner>
            </PreviewCard.Portal>
        </PreviewCard.Root>
    );
}
