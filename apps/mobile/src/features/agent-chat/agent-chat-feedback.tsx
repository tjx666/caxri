import { StyleSheet, Text, View } from 'react-native';

import type { AgentChatItem } from '@caxri/protocol';
import { agentChatNoticeHeading } from '@caxri/protocol';
import { CircleAlert, SquareTerminal, TriangleAlert } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
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
    const { t } = useTranslation();
    // Command output (`/rename` confirming a title) is informative, so it stays neutral like Desktop's.
    const tone =
        item.kind === 'error'
            ? { Icon: CircleAlert, color: theme.danger, border: theme.danger }
            : item.kind === 'warning'
              ? { Icon: TriangleAlert, color: theme.warning, border: theme.warning }
              : { Icon: SquareTerminal, color: theme.muted, border: theme.border };
    const { Icon, color } = tone;
    return (
        <View
            style={[
                styles.card,
                {
                    borderColor: tone.border,
                    backgroundColor: theme.surface,
                },
            ]}
            testID={`chat-feedback-${item.id}`}
        >
            <Icon color={color} size={18} />
            <View style={styles.content}>
                {item.heading && (
                    <Text selectable style={[styles.title, { color }]}>
                        {agentChatNoticeHeading(item.heading, t)}
                    </Text>
                )}
                <Text selectable style={[styles.body, { color }]}>
                    {item.message}
                </Text>
            </View>
        </View>
    );
}
