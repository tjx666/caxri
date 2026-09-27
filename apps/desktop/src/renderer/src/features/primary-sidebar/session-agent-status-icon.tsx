import type { SessionRecord } from '@caxri/protocol';
import { Unplug } from 'lucide-react';

import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import type { SessionStatusTerminal } from './session-status';
import { sessionStatus } from './session-status';

/**
 * The Session row's leading Agent icon, carrying the Agent's lifecycle on the icon itself: running wraps it in a
 * spinning arc, unread attention in a pinging warning ring, and a detached Agent dims it under an unplugged badge.
 *
 * The row splits its two status questions across its two edges on purpose. The leading icon answers "does this Agent
 * need me, or is it working?"; the trailing track answers only "how far has this delivery got?" (pull request and
 * deployment). One shared trailing slot used to rotate through both, so a running or unread Session hid its pull
 * request and the slot's meaning changed under the user's eye.
 *
 * The element always exists (its `data-session-status` is the contract lifecycle assertions read). A decorated state
 * shrinks the icon so the ring stays inside the 14px box's 3px halo and the row's title never shifts between states.
 */
export function SessionAgentStatusIcon({
    session,
    size = 14,
    terminal,
}: {
    session: SessionRecord;
    /**
     * The undecorated icon size. The box keeps this size in every state.
     */
    size?: number;
    terminal?: SessionStatusTerminal & { kind?: string };
}) {
    const status = sessionStatus(session, terminal);
    const isDecorated = status.kind === 'running' || status.kind === 'attention';
    const icon = (
        <AgentIdentityIcon
            identity={terminal?.kind ?? 'shell'}
            size={isDecorated ? size - 3 : size}
            tone="state"
        />
    );
    if (status.kind === 'default')
        return (
            <span
                aria-hidden="true"
                className="session-status flex flex-none items-center justify-center"
                data-session-status="default"
                style={{ height: size, width: size }}
            >
                {icon}
            </span>
        );

    return (
        <span
            role="img"
            aria-label={status.ariaLabel}
            className={cn(
                'session-status relative flex flex-none items-center justify-center',
                status.kind === 'attention'
                    ? 'session-status-attention text-warning'
                    : status.kind === 'detached'
                      ? 'session-status-detached text-muted'
                      : 'session-status-running',
            )}
            data-agent-operation={terminal?.agentOperation}
            data-attention-kind={
                status.kind === 'attention' ? session.lastAttentionKind : undefined
            }
            data-session-status={status.kind}
            style={{ height: size, width: size }}
        >
            {status.kind === 'running' && (
                <RunningArc className="absolute -inset-[3px] size-[calc(100%+6px)]" />
            )}
            {status.kind === 'attention' && (
                <>
                    <span
                        aria-hidden="true"
                        className="absolute -inset-[3px] rounded-full border-[1.5px] border-warning opacity-60 motion-safe:animate-ping motion-reduce:hidden"
                        data-session-status-ripple=""
                    />
                    <span
                        aria-hidden="true"
                        className="absolute -inset-[3px] rounded-full border-[1.5px] border-warning"
                    />
                </>
            )}
            <span aria-hidden="true" className={cn(status.kind === 'detached' && 'opacity-60')}>
                {icon}
            </span>
            {status.kind === 'detached' && (
                <span
                    aria-hidden="true"
                    className="absolute -right-1 -bottom-1 flex size-2.5 items-center justify-center rounded-full bg-surface"
                >
                    <Unplug size={8} strokeWidth={2.5} />
                </span>
            )}
        </span>
    );
}

/**
 * A thin arc over a faint track, in the icon's own color. Foreground rather than an accent: the list must stay neutral
 * (DESIGN.md keeps the screen's single accent on the focused pane), and a colored arc would compete with the amber
 * attention ring and the pull request glyph colors on the same row. Reduced motion leaves the arc still.
 */
export function RunningArc({
    className,
    strokeWidth = 1.5,
}: {
    className?: string;
    /**
     * In viewBox units (20). A smaller arc needs a heavier stroke to render at the same on-screen weight.
     */
    strokeWidth?: number;
}) {
    return (
        <svg
            aria-hidden="true"
            className={cn('flex-none motion-safe:animate-spin', className)}
            data-session-status-arc=""
            viewBox="0 0 20 20"
        >
            <circle
                cx="10"
                cy="10"
                fill="none"
                r="9.25"
                stroke="currentColor"
                strokeOpacity="0.25"
                strokeWidth={strokeWidth}
            />
            <circle
                cx="10"
                cy="10"
                fill="none"
                r="9.25"
                stroke="currentColor"
                strokeDasharray="14.5 58.1"
                strokeLinecap="round"
                strokeWidth={strokeWidth}
            />
        </svg>
    );
}
