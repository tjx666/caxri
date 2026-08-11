import { useEffect } from 'react';

import type { SessionRecord } from '@shared/types';

import { caxri } from '../../lib/caxri';
import { useSelectedSession } from '../../stores/selectors';

interface AttentionVisibility {
    documentVisible: boolean;
    windowFocused: boolean;
}

/** Read acknowledgement requires both durable unread state and a genuinely visible selection. */
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

/** Acknowledges the selected generation only after the Electron window actually displays it. */
export function useSessionAttentionAcknowledgement(): void {
    const session = useSelectedSession();
    useEffect(() => {
        if (!session?.hasUnread) return;
        let pending = false;
        const acknowledge = (): void => {
            if (pending || !shouldAcknowledgeSessionAttention(session, currentVisibility())) return;
            pending = true;
            void caxri
                .request('session.markRead', {
                    sessionId: session.id,
                    attentionEpoch: session.attentionEpoch,
                })
                .catch(() => {
                    /** Runtime recovery or the next focus event can safely retry the same generation. */
                    pending = false;
                });
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
