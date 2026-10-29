import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { SessionRecord, TerminalSurface } from '@caxri/protocol';
import { isChatTerminal } from '@caxri/protocol';

import { useOnVisible } from '@/hooks/use-on-visible';

import { useCaxriQuery } from '../../queries/client';
import { useSelectedSession, useTerminal } from '../../stores/selectors';
import {
    isAgentChatOnScreen,
    useAgentChatOnScreenStore,
} from '../agent-chat/waiting/agent-chat-on-screen';
import { markSessionRead } from './session-commands';

interface AttentionVisibility {
    documentVisible: boolean;
    windowFocused: boolean;
}

/**
 * Whether the Session's primary Chat holds a question or approval the user has not been shown: the Chat is waiting on
 * the user and its pane is not on screen in this window. Selecting the Session alone does not show the request (the
 * Chat can sit on a background tab), so acknowledging then would clear the attention glyph from the sidebar row and the
 * tab while the Agent is still blocked on the user.
 *
 * The Session's own `waiting` state counts as well as the pending-request list: it arrives in the same update that sets
 * `hasUnread`, while the list is a separate query that lands a few milliseconds later, after the acknowledgement has
 * already been sent. It counts only for a Chat, because a PTY Terminal has no Chat pane to show and would never clear.
 */
export function isChatRequestUnseen(
    session: Pick<SessionRecord, 'agentActivityState' | 'primaryAgentTerminalId'>,
    primaryTerminal: { surface?: TerminalSurface } | undefined,
    waitingTerminalIds: ReadonlySet<string>,
    onScreen: Readonly<Record<string, number>>,
): boolean {
    const terminalId = session.primaryAgentTerminalId;
    if (terminalId === undefined || !primaryTerminal || !isChatTerminal(primaryTerminal))
        return false;
    const isWaiting =
        waitingTerminalIds.has(terminalId) || session.agentActivityState === 'waiting';
    return isWaiting && !isAgentChatOnScreen(onScreen, terminalId);
}

/**
 * Read acknowledgement requires durable unread state, a genuinely visible selection, and no Chat request still hidden
 * from the user (see {@link isChatRequestUnseen}). Once the request is answered, withdrawn, or its pane shown, the
 * unread generation is acknowledged like any other.
 */
export function shouldAcknowledgeSessionAttention(
    session: SessionRecord | undefined,
    visibility: AttentionVisibility,
    hasUnseenChatRequest = false,
): session is SessionRecord {
    return Boolean(
        !hasUnseenChatRequest &&
        session?.hasUnread &&
        visibility.documentVisible &&
        visibility.windowFocused,
    );
}

function currentVisibility(): AttentionVisibility {
    return {
        documentVisible: document.visibilityState === 'visible',
        windowFocused: document.hasFocus(),
    };
}

/**
 * Acknowledges the selected generation only after the Electron window actually displays it.
 */
export function useSessionAttentionAcknowledgement(): void {
    const session = useSelectedSession();
    const isPendingReference = useRef(false);
    const { data, isPending: arePendingRequestsLoading } = useCaxriQuery(
        'agentChat.pendingRequests',
        {},
        { staleTime: Infinity },
    );
    const onScreen = useAgentChatOnScreenStore((state) => state.counts);
    const primaryTerminal = useTerminal(session?.primaryAgentTerminalId ?? '');
    const waitingTerminalIds = useMemo(
        () =>
            new Set(
                data?.entries
                    .filter((entry) => entry.kind === 'chat')
                    .map((chat) => chat.terminalId),
            ),
        [data],
    );
    /**
     * Until the pending requests first load, an off-screen request cannot be ruled out, so a launch or a fresh mount
     * holds acknowledgement rather than clearing Attention while the Agent is still blocked. A failed read settles the
     * query and lets acknowledgement proceed as before.
     */
    const hasUnseenChatRequest = session
        ? arePendingRequestsLoading ||
          isChatRequestUnseen(session, primaryTerminal, waitingTerminalIds, onScreen)
        : false;

    const acknowledge = useCallback((): void => {
        if (
            isPendingReference.current ||
            !shouldAcknowledgeSessionAttention(session, currentVisibility(), hasUnseenChatRequest)
        )
            return;
        isPendingReference.current = true;
        const acknowledgeAsync = async (): Promise<void> => {
            try {
                await markSessionRead(session.id, session.attentionGeneration);
            } catch {
                /**
                 * Server recovery or the next focus event can safely retry the same generation.
                 */
                isPendingReference.current = false;
            }
        };
        // Fire-and-forget: failures reset `isPendingReference` above so the next focus/visibility
        // event retries; there is nothing left for this handler to await.
        void acknowledgeAsync();
    }, [session, hasUnseenChatRequest]);

    useEffect(() => {
        if (!session?.hasUnread) return;
        isPendingReference.current = false;
        acknowledge();
    }, [session, acknowledge]);

    useOnVisible(acknowledge);
}
