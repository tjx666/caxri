/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MethodResult } from '@caxri/protocol';
import {
    AGENT_APPROVAL_ALLOW_LABEL,
    AGENT_APPROVAL_DENY_LABEL,
    agentApprovalAlwaysAllowLabel,
} from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import { REQUEST_CONTROL_ACCESS_MESSAGE } from '../agent-chat/agent-chat-model';

type Attention = MethodResult<'mobile.attention.list'>['requests'][number];

/**
 * A Terminal Agent's permission request names only the tool, so its buttons use the shared generic approval words; the
 * standing grant is scoped to the Session rather than a Chat.
 */
const ALWAYS_ALLOW_LABEL = agentApprovalAlwaysAllowLabel('Session');

const statusLabel = (status: Attention['status']): string => {
    if (status === 'applied') return 'Applied';
    if (status === 'answered') return 'Submitting…';
    return 'Already handled or expired';
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
}) => (
    <>
        <Text style={{ color: theme.text, fontWeight: '600' }}>
            {item.kind === 'permission'
                ? `Permission · ${item.toolName}`
                : `Agent question · ${questionIndex + 1}/${item.questions.length}`}
        </Text>
        {item.summary ? (
            <Text style={{ color: theme.muted }} numberOfLines={3}>
                {item.summary}
            </Text>
        ) : null}
        {item.status !== 'pending' ? (
            <Text style={{ color: theme.muted }}>{statusLabel(item.status)}</Text>
        ) : null}
        {role !== 'control' && item.status === 'pending' ? (
            <Text style={{ color: theme.muted }} testID="attention-control-required">
                {REQUEST_CONTROL_ACCESS_MESSAGE}
            </Text>
        ) : null}
    </>
);

export const AttentionPermissionActions = ({
    send,
    theme,
}: {
    /**
     * `shouldAutoAllow` is only ever passed as `true`, matching the protocol's `autoAllow?: z.literal(true)` field.
     */
    send: (decision: 'allow' | 'deny', shouldAutoAllow?: true) => Promise<void>;
    theme: MobileTheme;
}) => (
    <View style={{ gap: 8 }}>
        <View style={styles.actions}>
            <Pressable
                accessibilityLabel={AGENT_APPROVAL_ALLOW_LABEL}
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
                    {AGENT_APPROVAL_ALLOW_LABEL}
                </Text>
            </Pressable>
            <Pressable
                accessibilityLabel={AGENT_APPROVAL_DENY_LABEL}
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
                <Text style={[styles.actionLabel, { color: theme.text }]}>
                    {AGENT_APPROVAL_DENY_LABEL}
                </Text>
            </Pressable>
        </View>
        <Pressable
            accessibilityLabel={ALWAYS_ALLOW_LABEL}
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
            <Text style={[styles.actionLabel, { color: theme.text }]}>{ALWAYS_ALLOW_LABEL}</Text>
        </Pressable>
        {/* The caption sits under the button it explains, so it does not repeat the button's name or scope. */}
        <Text style={{ color: theme.muted, fontSize: 12 }}>
            Approves this and every later permission request until it is turned off or the Agent
            restarts. Agent questions still ask you.
        </Text>
    </View>
);

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
