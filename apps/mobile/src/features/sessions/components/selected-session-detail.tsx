import { useCallback } from 'react';

import { useRouter } from 'expo-router';

import type { useMobileTheme } from '../../../theme/use-mobile-theme';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileLayoutMode } from '../../layout/layout-mode';
import type { useSessionConversation } from '../hooks/use-session-conversation';
import type { MobileSessionItem } from '../session-model';
import { useHostSessions } from './host-sessions-provider';
import { SessionDetail } from './session-detail';

export const SelectedSessionDetail = ({
    conversation,
    fresh,
    isDetailVisible,
    layout,
    selected,
    theme,
    wideBackgroundSegment,
}: {
    conversation: ReturnType<typeof useSessionConversation>;
    fresh: boolean;
    isDetailVisible: boolean;
    layout: MobileLayoutMode;
    selected: MobileSessionItem;
    theme: ReturnType<typeof useMobileTheme>;
    wideBackgroundSegment: 'conversation' | 'terminal';
}) => {
    const router = useRouter();
    const { request } = useMobileClient();
    const {
        consumeComposerFocus,
        focusComposerSessionId,
        hostId,
        sessions,
        setDraft,
        setSegment,
        ui,
    } = useHostSessions();
    const { refresh } = sessions;
    const goHome = useCallback((): void => {
        router.replace(`/h/${encodeURIComponent(hostId)}`);
    }, [hostId, router]);
    const markRead = useCallback(async (): Promise<void> => {
        await request('session.markRead', {
            sessionId: selected.id,
            attentionEpoch: selected.attentionEpoch,
        });
        await refresh();
    }, [refresh, request, selected]);

    return (
        <SessionDetail
            conversationFallback={conversation.fallback}
            conversationTimeline={conversation.timeline}
            deviceRole={sessions.deviceRole}
            draft={ui.draftBySession[selected.id] ?? ''}
            focusComposer={focusComposerSessionId === selected.id}
            hostId={hostId}
            isConnected={fresh}
            isVisible={isDetailVisible}
            onBack={layout === 'phone' ? goHome : undefined}
            onDraftChange={(draft) => setDraft(selected.id, draft)}
            onComposerFocused={() => consumeComposerFocus(selected.id)}
            onMarkRead={markRead}
            onRefresh={refresh}
            onSegmentChange={(next) => setSegment(selected.id, next, conversation.segment)}
            segment={conversation.segment}
            session={selected}
            theme={theme}
            wideChanges={layout === 'tablet-wide'}
            wideBackgroundSegment={wideBackgroundSegment}
        />
    );
};
