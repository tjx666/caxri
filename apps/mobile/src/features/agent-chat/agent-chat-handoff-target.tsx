/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { use } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { agentChatSessionHandoffTarget } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useHostSessions } from '../sessions/components/host-sessions-provider';
import { allMobileSessions } from '../sessions/hooks/use-session-polling';
import { sessionTitleForDisplay } from '../sessions/session-row-model';
import { AgentChatSessionId } from './agent-chat-handoff';
import { useOpenSession } from './use-open-session';

/**
 * Where a `/new-session` message handed off to, once the Agent created the new Session: "Continued in" and a link to
 * it, as Desktop's row under the card. Nothing while it does not exist yet, or when the phone does not list it (the
 * phone's list holds no archived Session, so an archived target also reads as nothing rather than a dead link).
 */
export const AgentChatHandoffTarget = ({
    sentAt,
    theme,
}: {
    /**
     * When the message entered the conversation; absent for history the provider kept no time for.
     */
    sentAt: number | undefined;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const sourceSessionId = use(AgentChatSessionId);
    const { sessions } = useHostSessions();
    const openSession = useOpenSession();
    const target = agentChatSessionHandoffTarget(
        allMobileSessions(sessions.sections),
        sourceSessionId,
        sentAt,
    );
    if (!target) return null;
    return (
        <View style={[styles.row, { borderColor: theme.border }]}>
            <Text style={[styles.label, { color: theme.muted }]}>
                {t('chat.handoff.continuedIn')}
            </Text>
            <Pressable
                accessibilityHint={t('chat.handoff.openTargetHint')}
                accessibilityRole="link"
                hitSlop={8}
                onPress={() => openSession(target.id)}
                style={styles.link}
                testID={`agent-chat-handoff-target-${target.id}`}
            >
                <Text numberOfLines={1} style={[styles.title, { color: theme.primary }]}>
                    {sessionTitleForDisplay(target.title, t)}
                </Text>
            </Pressable>
        </View>
    );
};

const styles = StyleSheet.create({
    row: {
        alignItems: 'center',
        borderTopWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        marginTop: mobileSpace.sm,
        paddingTop: mobileSpace.sm,
    },
    label: { ...mobileType.meta, flexShrink: 0 },
    link: { flexShrink: 1 },
    title: { ...mobileType.meta, flexShrink: 1 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
