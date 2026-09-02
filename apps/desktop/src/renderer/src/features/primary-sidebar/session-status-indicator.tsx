import type { SessionRecord } from '@caxri/protocol';
import { Unplug } from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utilities';
import type { SessionStatusTerminal } from './session-status';
import { sessionStatus } from './session-status';

/**
 * The fixed right-edge status slot shared by the PrimarySidebar and MRU switcher. Unread attention moves, background
 * acknowledged waiting stays still, running spins, a detached Agent shows a static unplugged glyph, and settled states
 * leave the reserved slot empty so rows never reflow as lifecycle signals change.
 */
export function SessionStatusIndicator({
    className,
    isCurrentSession = false,
    session,
    terminal,
}: {
    className?: string;
    isCurrentSession?: boolean;
    session: SessionRecord;
    terminal?: SessionStatusTerminal;
}) {
    const status = sessionStatus(session, terminal, isCurrentSession);
    if (status.kind === 'default') {
        return (
            <span
                aria-hidden="true"
                className={cn('session-status size-3.5 flex-none', className)}
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
            data-attention-emphasis={status.kind === 'attention' ? status.emphasis : undefined}
            data-attention-kind={
                status.kind === 'attention' ? session.lastAttentionKind : undefined
            }
            data-session-status={status.kind}
        >
            {status.kind === 'attention' ? (
                <>
                    {status.emphasis === 'unread' && (
                        <span
                            aria-hidden="true"
                            className="absolute inset-0 rounded-full border border-warning opacity-75 motion-safe:animate-ping motion-reduce:hidden"
                            data-session-status-ripple=""
                        />
                    )}
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
