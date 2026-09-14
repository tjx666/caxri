import { useCallback, useEffect, useRef } from 'react';

import type { SessionRecord } from '@caxri/protocol';

import { useOnVisible } from '@/hooks/use-on-visible';

import { useSelectedSession } from '../../stores/selectors';
import { markSessionRead } from './session-commands';

interface AttentionVisibility {
    documentVisible: boolean;
    windowFocused: boolean;
}

/**
 * Read acknowledgement requires both durable unread state and a genuinely visible selection.
 */
export function shouldAcknowledgeSessionAttention(
    session: SessionRecord | undefined,
    visibility: AttentionVisibility,
): session is SessionRecord {
    return Boolean(session?.hasUnread && visibility.documentVisible && visibility.windowFocused);
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

    const acknowledge = useCallback((): void => {
        if (
            isPendingReference.current ||
            !shouldAcknowledgeSessionAttention(session, currentVisibility())
        )
            return;
        isPendingReference.current = true;
        const acknowledgeAsync = async (): Promise<void> => {
            try {
                await markSessionRead(session.id, session.attentionEpoch);
            } catch {
                /**
                 * Server recovery or the next focus event can safely retry the same generation.
                 */
                isPendingReference.current = false;
            }
        };
        // Fire-and-forget: failures reset `isPendingReference` above so the next focus/visibility
        // event retries; there is nothing left for this handler to await.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void acknowledgeAsync();
    }, [session]);

    useEffect(() => {
        if (!session?.hasUnread) return;
        isPendingReference.current = false;
        acknowledge();
    }, [session, acknowledge]);

    useOnVisible(acknowledge);
}
