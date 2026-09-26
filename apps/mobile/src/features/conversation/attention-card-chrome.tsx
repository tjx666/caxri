import { Pressable, Text, View } from 'react-native';

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
    send: (decision: 'allow' | 'deny') => Promise<void>;
    theme: MobileTheme;
}) => (
    <View style={{ flexDirection: 'row', gap: 16 }}>
        <Pressable
            accessibilityLabel="Allow once"
            accessibilityRole="button"
            testID="attention-allow-once"
            onPress={() => send('allow')}
        >
            <Text style={{ color: theme.primary }}>Allow once</Text>
        </Pressable>
        <Pressable
            accessibilityLabel="Deny"
            accessibilityRole="button"
            testID="attention-deny"
            onPress={() => send('deny')}
        >
            <Text style={{ color: theme.danger }}>Deny</Text>
        </Pressable>
    </View>
);
