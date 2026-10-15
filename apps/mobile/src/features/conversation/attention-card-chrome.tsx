/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MethodResult } from '@caxri/protocol';
import { agentApprovalAlwaysAllowLabel } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { requestControlAccessMessage } from '../agent-chat/agent-chat-model';

type Attention = MethodResult<'mobile.attention.list'>['requests'][number];

const statusLabel = (status: Attention['status'], t: Translate): string => {
    if (status === 'applied') return t('conversation.attention.statusApplied');
    if (status === 'answered') return t('conversation.attention.statusSubmitting');
    return t('conversation.attention.statusClosed');
};

export const AttentionCardChrome = ({
    item,
    questionIndex,
    role,
    theme,
}: {
    item: Attention;
    questionIndex: number;
    role: 'view' | 'reply' | 'control' | null;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <>
            <Text style={{ color: theme.text, fontWeight: '600' }}>
                {item.kind === 'permission'
                    ? t('conversation.attention.permissionTitle', { tool: item.toolName })
                    : t('conversation.attention.questionTitle', {
                          count: item.questions.length,
                          index: questionIndex + 1,
                      })}
            </Text>
            {item.summary ? (
                <Text style={{ color: theme.muted }} numberOfLines={3}>
                    {item.summary}
                </Text>
            ) : null}
            {item.status !== 'pending' ? (
                <Text style={{ color: theme.muted }}>{statusLabel(item.status, t)}</Text>
            ) : null}
            {role !== 'control' && item.status === 'pending' ? (
                <Text style={{ color: theme.muted }} testID="attention-control-required">
                    {requestControlAccessMessage(t)}
                </Text>
            ) : null}
        </>
    );
};

export const AttentionPermissionActions = ({
    send,
    theme,
}: {
    /**
     * `shouldAutoAllow` is only ever passed as `true`, matching the protocol's `autoAllow?: z.literal(true)` field.
     */
    send: (decision: 'allow' | 'deny', shouldAutoAllow?: true) => Promise<void>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    /**
     * A Terminal Agent's permission request names only the tool, so its buttons use the shared generic approval words;
     * the standing grant is scoped to the Session rather than a Chat.
     */
    const allowLabel = t('agentChat.approval.allow');
    const denyLabel = t('agentChat.approval.deny');
    const alwaysAllowLabel = agentApprovalAlwaysAllowLabel('Session', t);
    return (
        <View style={{ gap: 8 }}>
            <View style={styles.actions}>
                <Pressable
                    accessibilityLabel={allowLabel}
                    accessibilityRole="button"
                    testID="attention-allow-once"
                    onPress={() => send('allow')}
                    style={({ pressed }) => [
                        styles.action,
                        {
                            backgroundColor: theme.primary,
                            borderColor: theme.primary,
                            opacity: pressed ? 0.76 : 1,
                        },
                    ]}
                >
                    <Text style={[styles.actionLabel, { color: theme.primaryForeground }]}>
                        {allowLabel}
                    </Text>
                </Pressable>
                <Pressable
                    accessibilityLabel={denyLabel}
                    accessibilityRole="button"
                    testID="attention-deny"
                    onPress={() => send('deny')}
                    style={({ pressed }) => [
                        styles.action,
                        {
                            backgroundColor: pressed ? theme.elevated : 'transparent',
                            borderColor: theme.border,
                        },
                    ]}
                >
                    <Text style={[styles.actionLabel, { color: theme.text }]}>{denyLabel}</Text>
                </Pressable>
            </View>
            <Pressable
                accessibilityLabel={alwaysAllowLabel}
                accessibilityRole="button"
                testID="attention-always-allow"
                onPress={() => send('allow', true)}
                style={({ pressed }) => [
                    styles.action,
                    {
                        backgroundColor: pressed ? theme.elevated : 'transparent',
                        borderColor: theme.border,
                    },
                ]}
            >
                <Text style={[styles.actionLabel, { color: theme.text }]}>{alwaysAllowLabel}</Text>
            </Pressable>
            {/* The caption sits under the button it explains, so it does not repeat the button's name or scope. */}
            <Text style={{ color: theme.muted, fontSize: 12 }}>
                {t('conversation.attention.alwaysAllowCaption')}
            </Text>
        </View>
    );
};

const styles = StyleSheet.create({
    actions: { flexDirection: 'row', gap: 8 },
    action: {
        alignItems: 'center',
        borderRadius: 10,
        borderWidth: 1,
        flex: 1,
        justifyContent: 'center',
        minHeight: 48,
        paddingHorizontal: 12,
    },
    actionLabel: { fontSize: 15, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
