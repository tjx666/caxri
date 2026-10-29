/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, View } from 'react-native';

import { useQuery } from '@tanstack/react-query';

import { useTranslation } from '../../../i18n';
import { mobileSpace } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import {
    agentChatProviderName,
    agentChatRequestBlockedReason,
} from '../../agent-chat/agent-chat-model';
import { AgentChatRequestCard } from '../../agent-chat/agent-chat-request-card';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { isAttentionQueryEnabled } from '../../conversation/attention-cards-model';
import type { MobileTerminal } from '../session-model';

/**
 * The approval a waiting Chat Session shows under its row in the Sessions list: the same card the Chat docks above its
 * composer, answered through the same `mobile.agentChat.respond`, so the phone handles a Codex, Grok, or Claude Chat
 * approval without opening the Chat. The list is polled from Core's in-memory projection (`mobile.agentChat.requests`),
 * which never starts a provider. Only the first request shows, with the count of the rest; the Chat lists them all.
 */
export const SessionChatRequests = ({
    role,
    terminal,
    theme,
}: {
    role: 'view' | 'reply' | 'control' | null;
    terminal: MobileTerminal;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { request, connectionScopeKey, isForeground, status } = useMobileClient();
    const terminalId = terminal.id;
    const query = useQuery({
        enabled: isAttentionQueryEnabled(isForeground, status, connectionScopeKey),
        queryFn: () => request('mobile.agentChat.requests', { terminalId }),
        queryKey: ['mobile', 'agentChatRequests', connectionScopeKey, terminalId],
        refetchInterval: 1_500,
        retry: false,
    });
    const requests = query.data?.requests ?? [];
    const current = requests.at(0);
    if (!current) return null;
    return (
        <View testID="session-chat-requests">
            <View style={styles.card}>
                <AgentChatRequestCard
                    blockedReason={agentChatRequestBlockedReason({
                        deviceRole: role,
                        isConnected: status === 'connected',
                    })}
                    items={[]}
                    onRespond={async (target, response) => {
                        await request('mobile.agentChat.respond', {
                            terminalId,
                            requestId: target.id,
                            response,
                        });
                        await query.refetch();
                    }}
                    positionLabel={
                        requests.length > 1
                            ? t('chat.request.position', { count: requests.length, index: 1 })
                            : undefined
                    }
                    provider={agentChatProviderName(terminal)}
                    request={current}
                    theme={theme}
                />
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    card: { paddingBottom: mobileSpace.sm, paddingHorizontal: mobileSpace.lg },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
