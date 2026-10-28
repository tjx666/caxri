/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text } from 'react-native';

import { Pencil } from 'lucide-react-native';

import { Card } from '../../components/card';
import { useTranslation } from '../../i18n';
import { mobileControl, mobileSpace, mobileType, PRESSED_OPACITY } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatMessageEditCaption } from './agent-chat-message-edit';

/**
 * The card above the composer while it holds "Edit from Here": what sending replaces, and Cancel, which puts the draft
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
        <Card padded={false} style={styles.banner} testID="agent-chat-edit-banner" theme={theme}>
            <Pencil color={theme.muted} size={16} />
            <Text style={[styles.caption, { color: theme.muted }]}>
                {agentChatMessageEditCaption(removedTurns, t)}
            </Text>
            <Pressable
                accessibilityLabel={t('chat.edit.cancel')}
                accessibilityRole="button"
                onPress={onCancel}
                style={({ pressed }) => [styles.cancel, { opacity: pressed ? PRESSED_OPACITY : 1 }]}
                testID="agent-chat-edit-cancel"
            >
                <Text style={[styles.cancelText, { color: theme.primary }]}>
                    {t('common.cancel')}
                </Text>
            </Pressable>
        </Card>
    );
};

const styles = StyleSheet.create({
    banner: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        marginBottom: mobileSpace.sm,
        paddingLeft: mobileSpace.md,
    },
    caption: { ...mobileType.meta, flex: 1 },
    cancel: {
        justifyContent: 'center',
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.md,
    },
    cancelText: { ...mobileType.bodyStrong },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
