/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MethodResult } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';

type Attention = MethodResult<'mobile.attention.list'>['requests'][number];

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
            <Text style={{ color: theme.muted }}>
                Control access is required to answer this request.
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
                accessibilityLabel="Allow once"
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
                    Allow once
                </Text>
            </Pressable>
            <Pressable
                accessibilityLabel="Deny"
                accessibilityRole="button"
                testID="attention-deny"
                onPress={() => send('deny')}
                style={({ pressed }) => [
                    styles.action,
                    {
                        backgroundColor: pressed ? theme.elevated : 'transparent',
                        borderColor: theme.danger,
                    },
                ]}
            >
                <Text style={[styles.actionLabel, { color: theme.danger }]}>Deny</Text>
            </Pressable>
        </View>
        <Pressable
            accessibilityLabel="Always allow in this Session"
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
            <Text style={[styles.actionLabel, { color: theme.text }]}>
                Always allow in this Session
            </Text>
        </Pressable>
        <Text style={{ color: theme.muted, fontSize: 12 }}>
            Always allow approves this and every later permission request in this Session
            automatically, until it is turned off or the Agent restarts. Agent questions still ask
            you.
        </Text>
    </View>
);

const styles = StyleSheet.create({
    actions: { flexDirection: 'row', gap: 12 },
    action: {
        alignItems: 'center',
        borderRadius: 10,
        borderWidth: 1,
        flex: 1,
        justifyContent: 'center',
        minHeight: 44,
        paddingHorizontal: 12,
    },
    actionLabel: { fontSize: 15, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
