import { StyleSheet, Text, View } from 'react-native';

import type { AgentChatItem } from '@caxri/protocol';
import { CircleAlert, SquareTerminal, TriangleAlert } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';

const styles = StyleSheet.create({
    card: {
        flexDirection: 'row',
        gap: 10,
        borderWidth: 1,
        borderRadius: 8,
        padding: 12,
        marginVertical: 6,
    },
    content: { flex: 1, minWidth: 0, gap: 4 },
    title: { fontSize: 13, lineHeight: 20, fontWeight: '600' },
    body: { fontSize: 13, lineHeight: 20 },
});

/**
 * Explicit provider feedback keeps its source and complete details visible, including after history restoration.
 */
export function AgentChatFeedback({
    item,
    theme,
}: {
    item: Extract<AgentChatItem, { type: 'notice' }>;
    theme: MobileTheme;
}) {
    const color =
        item.kind === 'error'
            ? theme.danger
            : item.kind === 'warning'
              ? theme.warning
              : theme.muted;
    const Icon =
        item.kind === 'error'
            ? CircleAlert
            : item.kind === 'warning'
              ? TriangleAlert
              : SquareTerminal;
    return (
        <View
            style={[styles.card, { borderColor: color, backgroundColor: theme.surface }]}
            testID={`chat-feedback-${item.id}`}
        >
            <Icon color={color} size={18} />
            <View style={styles.content}>
                {item.title && (
                    <Text selectable style={[styles.title, { color }]}>
                        {item.title}
                    </Text>
                )}
                <Text selectable style={[styles.body, { color: theme.text }]}>
                    {item.message}
                </Text>
            </View>
        </View>
    );
}
