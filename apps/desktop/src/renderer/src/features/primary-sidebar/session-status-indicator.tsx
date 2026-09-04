import type { SessionRecord } from '@caxri/protocol';
import { Unplug } from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utilities';
import type { SessionStatusTerminal } from './session-status';
import { sessionStatus } from './session-status';

/**
 * The right-edge status glyph shared by the PrimarySidebar and MRU switcher. Unread attention pings until it is read,
 * running spins, and a detached Agent shows a static unplugged glyph.
 *
 * A settled Session keeps the element in the DOM (its `data-session-status` is the contract lifecycle assertions read)
 * but collapses it to nothing, so callers that right-align their glyphs do not strand a neighbour a slot short of the
 * row's right edge. Callers whose neighbouring column must stay on one vertical line pass `reserveSlot` instead.
 */
export function SessionStatusIndicator({
    className,
    reserveSlot = false,
    session,
    terminal,
}: {
    className?: string;
    /**
     * Renders the settled state as a 14px placeholder rather than collapsing it. Use it when a neighbouring
     * variable-width column — the MRU switcher's relative timestamp — would otherwise shift as the status appears.
     */
    reserveSlot?: boolean;
    session: SessionRecord;
    terminal?: SessionStatusTerminal;
}) {
    const status = sessionStatus(session, terminal);
    if (status.kind === 'default') {
        return (
            <span
                aria-hidden="true"
                className={cn(
                    'session-status flex-none',
                    reserveSlot ? 'size-3.5' : 'hidden',
                    className,
                )}
                data-session-status="default"
            />
        );
    }

    return (
        <span
            role="img"
            aria-label={status.ariaLabel}
            className={cn(
                'session-status relative flex size-3.5 flex-none items-center justify-center',
                status.kind === 'attention'
                    ? 'session-status-attention text-warning'
                    : status.kind === 'detached'
                      ? 'session-status-detached text-muted'
                      : 'session-status-running text-muted',
                className,
            )}
            data-agent-operation={terminal?.agentOperation}
            data-attention-kind={
                status.kind === 'attention' ? session.lastAttentionKind : undefined
            }
            data-session-status={status.kind}
        >
            {status.kind === 'attention' ? (
                <>
                    <span
                        aria-hidden="true"
                        className="absolute inset-0 rounded-full border border-warning opacity-75 motion-safe:animate-ping motion-reduce:hidden"
                        data-session-status-ripple=""
                    />
                    <span
                        aria-hidden="true"
                        className="size-3.5 rounded-full border border-warning"
                    />
                    <span aria-hidden="true" className="absolute size-2 rounded-full bg-warning" />
                </>
            ) : status.kind === 'detached' ? (
                <Unplug aria-hidden="true" size={12} />
            ) : (
                <Spinner aria-hidden="true" className="size-3.5" />
            )}
        </span>
    );
}
