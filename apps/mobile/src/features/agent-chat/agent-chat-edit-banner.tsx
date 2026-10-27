/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Pencil } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatMessageEditCaption } from './agent-chat-message-edit';

/**
 * The strip above the composer while it holds "Edit from Here": what sending replaces, and Cancel, which puts the draft
 * held back by the edit back into the composer. Desktop's composer caption reads the same.
 */
export const AgentChatEditBanner = ({
    onCancel,
    removedTurns,
    theme,
}: {
    onCancel: () => void;
    removedTurns: number;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View
            style={[styles.banner, { backgroundColor: theme.surface }]}
            testID="agent-chat-edit-banner"
        >
            <Pencil color={theme.muted} size={16} />
            <Text style={[styles.caption, { color: theme.muted }]}>
                {agentChatMessageEditCaption(removedTurns, t)}
            </Text>
            <Pressable
                accessibilityLabel={t('chat.edit.cancel')}
                accessibilityRole="button"
                hitSlop={8}
                onPress={onCancel}
                style={({ pressed }) => [styles.cancel, { opacity: pressed ? 0.6 : 1 }]}
                testID="agent-chat-edit-cancel"
            >
                <Text style={[styles.cancelText, { color: theme.primary }]}>
                    {t('common.cancel')}
                </Text>
            </Pressable>
        </View>
    );
};

const styles = StyleSheet.create({
    banner: {
        alignItems: 'center',
        borderRadius: 10,
        flexDirection: 'row',
        gap: 8,
        marginBottom: 8,
        minHeight: 40,
        paddingHorizontal: 10,
    },
    caption: { flex: 1, fontSize: 13, lineHeight: 18 },
    cancel: { justifyContent: 'center', minHeight: 32, paddingHorizontal: 4 },
    cancelText: { fontSize: 14, fontWeight: '600' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
