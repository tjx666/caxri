import type { AgentOperation, SessionRecord } from '@caxri/protocol';

import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utilities';
import { sessionStatus } from './session-status';

/**
 * The fixed right-edge status slot shared by the PrimarySidebar and MRU switcher. Unread attention moves, persistent
 * waiting stays still, running spins, and settled states leave the reserved slot empty so rows never reflow as
 * lifecycle signals change.
 */
export function SessionStatusIndicator({
    agentOperation,
    className,
    session,
}: {
    agentOperation?: AgentOperation;
    className?: string;
    session: SessionRecord;
}) {
    const status = sessionStatus(session, agentOperation);
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
                    : 'session-status-running text-muted',
                className,
            )}
            data-agent-operation={agentOperation}
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
            ) : (
                <Spinner aria-hidden="true" className="size-3.5" />
            )}
        </span>
    );
}
