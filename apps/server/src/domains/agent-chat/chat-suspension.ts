import type { TerminalRecord } from '@caxri/protocol';

import type { ChatState } from './chat-states';

/**
 * Whether a live Chat can be stopped without losing anything the user has not seen: its provider is ready and bound to
 * an Agent Session it can resume, and no turn, approval, operation, background task, or queued message is pending. A
 * Chat that is not bound yet has no conversation to resume, so stopping it would only discard its draft settings.
 */
export function isChatIdleForSuspension(
    state: ChatState,
    terminal: Pick<TerminalRecord, 'agentSessionId'>,
): boolean {
    const snapshot = state.projection.snapshot;
    return (
        state.session?.isOpen === true &&
        state.retiring === undefined &&
        terminal.agentSessionId !== undefined &&
        snapshot.status === 'ready' &&
        snapshot.activeTurnId === undefined &&
        snapshot.requests.length === 0 &&
        snapshot.operation === undefined &&
        !snapshot.tasks?.some((task) => task.status === 'running') &&
        (snapshot.queue?.length ?? 0) === 0 &&
        (snapshot.queueLength ?? 0) === 0
    );
}
