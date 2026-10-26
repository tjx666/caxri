/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatQueueImagesAttached, canSaveAgentChatQueueEdit } from './agent-chat-queue';
import type { AgentChatQueueInPlaceEdit } from './use-agent-chat-queue-actions';

/**
 * Edits the text of a queued message that carries images or file references, in its own row: neither can return to the
 * composer, so the message is rewritten where it stands. Only what the user typed is shown; the references stay
 * attached, and a note says how many images ride with it, worded as Desktop's. A failed save keeps the typed text.
 */
export const AgentChatQueueEditor = ({
    editing,
    isSaving,
    onCancel,
    onSave,
    theme,
}: {
    editing: AgentChatQueueInPlaceEdit;
    isSaving: boolean;
    onCancel: () => void;
    onSave: (text: string) => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [value, setValue] = useState(editing.text);
    const canSave = !isSaving && canSaveAgentChatQueueEdit(value, editing.imageCount);
    return (
        <View style={styles.editor} testID="agent-chat-queue-editor">
            <TextInput
                accessibilityLabel={t('chat.queue.editLabel')}
                autoFocus
                multiline
                onChangeText={setValue}
                placeholderTextColor={theme.muted}
                style={[
                    styles.editorInput,
                    {
                        backgroundColor: theme.elevated,
                        borderColor: theme.border,
                        color: theme.text,
                    },
                ]}
                testID="agent-chat-queue-editor-input"
                value={value}
            />
            <View style={styles.editorFooter}>
                <Text style={[styles.note, { color: theme.muted }]}>
                    {editing.imageCount > 0
                        ? agentChatQueueImagesAttached(editing.imageCount, t)
                        : ''}
                </Text>
                <Pressable
                    accessibilityRole="button"
                    disabled={isSaving}
                    onPress={onCancel}
                    style={styles.editorButton}
                    testID="agent-chat-queue-editor-cancel"
                >
                    <Text style={[styles.cancelText, { color: theme.muted }]}>
                        {t('chat.queue.cancelEdit')}
                    </Text>
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ busy: isSaving, disabled: !canSave }}
                    disabled={!canSave}
                    onPress={() => onSave(value)}
                    style={[
                        styles.editorButton,
                        styles.editorSave,
                        { backgroundColor: theme.primary, opacity: canSave ? 1 : 0.38 },
                    ]}
                    testID="agent-chat-queue-editor-save"
                >
                    {isSaving ? (
                        <Spinner color={theme.primaryForeground} />
                    ) : (
                        <Text style={[styles.saveText, { color: theme.primaryForeground }]}>
                            {t('chat.queue.saveEdit')}
                        </Text>
                    )}
                </Pressable>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    editor: { gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
    editorInput: {
        borderRadius: 10,
        borderWidth: 1,
        fontSize: 14,
        lineHeight: 19,
        maxHeight: 140,
        minHeight: 44,
        paddingHorizontal: 10,
        paddingVertical: 8,
        textAlignVertical: 'top',
    },
    editorFooter: { alignItems: 'center', flexDirection: 'row', gap: 8 },
    note: { flex: 1, fontSize: 12 },
    editorButton: {
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 40,
        minWidth: 64,
        paddingHorizontal: 12,
    },
    cancelText: { fontSize: 13, fontWeight: '700' },
    editorSave: { borderRadius: 20 },
    saveText: { fontSize: 13, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
