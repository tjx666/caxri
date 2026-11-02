import { isSessionReferenceable } from '@caxri/protocol';

/**
 * Why a Session row dragged onto a Chat cannot be cited there: `self` is the Chat's own Session, `unavailable` is a
 * Session with no Agent conversation to condense (unknown, archived, or without a Primary Agent).
 */
export type AgentChatSessionDropRefusal = 'self' | 'unavailable';

/**
 * What a Chat's composer would do with a drag: take paths, cite a Session row, or refuse a Session row with a reason.
 */
export type AgentChatComposerDragKind =
    'paths' | 'session' | 'refused-self' | 'refused-unavailable';

/**
 * Whether the Chat of `currentSessionId` may cite `session`, or why not. The Chat's own Session is told apart from the
 * rest because it is the one drag a user makes by mistake and the reason differs.
 */
export function agentChatSessionDropVerdict(
    session: { archivedAt?: number; id: string; primaryAgentTerminalId?: string } | undefined,
    currentSessionId: string | undefined,
    draggedSessionId: string,
): 'ok' | AgentChatSessionDropRefusal {
    if (currentSessionId !== undefined && draggedSessionId === currentSessionId) return 'self';
    if (session === undefined || !isSessionReferenceable(session, currentSessionId))
        return 'unavailable';
    return 'ok';
}

/**
 * Classifies a drag over the composer. A dragged Session row wins over paths; `isPathDrag` is only consulted without
 * one.
 */
export function agentChatComposerDragKind(
    draggedSession: { id: string; verdict: 'ok' | AgentChatSessionDropRefusal } | undefined,
    isPathDrag: () => boolean,
): AgentChatComposerDragKind | undefined {
    if (draggedSession) {
        return draggedSession.verdict === 'ok' ? 'session' : `refused-${draggedSession.verdict}`;
    }
    return isPathDrag() ? 'paths' : undefined;
}
