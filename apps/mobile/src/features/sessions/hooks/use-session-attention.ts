import { useEffect, useRef } from 'react';

import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileSessionItem } from '../session-model';

export const sessionReadKey = (session: MobileSessionItem): string =>
    `${session.id}:${session.attentionEpoch}`;

export const useSessionAttention = ({
    enabled,
    onRefresh,
    session,
}: {
    enabled: boolean;
    onRefresh: () => Promise<void>;
    session: MobileSessionItem | null;
}): void => {
    const { request } = useMobileClient();
    const markedRead = useRef(new Set<string>());

    useEffect(() => {
        if (!enabled || !session?.hasUnread) return;
        const key = sessionReadKey(session);
        if (markedRead.current.has(key)) return;
        markedRead.current.add(key);
        const markRead = async (): Promise<void> => {
            try {
                await request('session.markRead', {
                    sessionId: session.id,
                    attentionEpoch: session.attentionEpoch,
                });
                await onRefresh();
            } catch {
                markedRead.current.delete(key);
            }
        };
        void markRead();
    }, [enabled, onRefresh, request, session]);
};
