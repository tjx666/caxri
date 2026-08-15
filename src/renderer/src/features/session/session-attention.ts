import { useEffect } from 'react';

import type { SessionRecord } from '@shared/types';

import { caxri } from '../../lib/caxri';
import { useSelectedSession } from '../../stores/selectors';

interface AttentionVisibility {
    documentVisible: boolean;
    windowFocused: boolean;
}

/**
Read acknowledgement requires both durable unread state and a genuinely visible selection.
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
Acknowledges the selected generation only after the Electron window actually displays it.
 */
export function useSessionAttentionAcknowledgement(): void {
    const session = useSelectedSession();
    useEffect(() => {
        if (!session?.hasUnread) return;
        let isPending = false;
        const acknowledgeAsync = async (): Promise<void> => {
            try {
                await caxri.request('session.markRead', {
                    sessionId: session.id,
                    attentionEpoch: session.attentionEpoch,
                });
            } catch {
                /**
                Runtime recovery or the next focus event can safely retry the same generation.
                 */
                isPending = false;
            }
        };
        const acknowledge = (): void => {
            if (isPending || !shouldAcknowledgeSessionAttention(session, currentVisibility()))
                return;
            isPending = true;
            // Fire-and-forget: failures reset `isPending` above so the next focus/visibility event
            // retries; there is nothing left for this handler to await.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void acknowledgeAsync();
        };
        acknowledge();
        window.addEventListener('focus', acknowledge);
        document.addEventListener('visibilitychange', acknowledge);
        return () => {
            window.removeEventListener('focus', acknowledge);
            document.removeEventListener('visibilitychange', acknowledge);
        };
    }, [session]);
}
