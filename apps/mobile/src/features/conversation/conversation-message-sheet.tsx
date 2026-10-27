/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import * as Clipboard from 'expo-clipboard';
import { Copy, Pencil, TextCursor } from 'lucide-react-native';

import { BottomSheet, SheetAction, SheetCancel } from '../../components/bottom-sheet';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';

/**
 * "Edit from Here" as a message sheet offers it: enabled, or dimmed with the reason it cannot run now.
 */
export interface ConversationMessageEditAction {
    availability: { canEdit: true } | { canEdit: false; reason: string };
    onEdit: (text: string) => void;
}

type Busy = 'copy' | 'edit' | 'select';

/**
 * A long-pressed message's actions: Copy Message puts its whole text on the clipboard (a reply as its Markdown source,
 * as Desktop's Copy Message does), Select Text shows that text selectable so any part of it can be copied, and a Chat's
 * own message adds "Edit from Here". `readText` resolves the whole text, which may need a read from the Server when the
 * phone holds only the message's tail.
 */
export const ConversationMessageSheet = ({
    edit,
    onClose,
    readText,
    theme,
}: {
    edit?: ConversationMessageEditAction;
    onClose: () => void;
    readText: () => Promise<string>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [selectText, setSelectText] = useState<string>();
    const [busy, setBusy] = useState<Busy>();
    const [error, setError] = useState<string>();
    /**
     * The whole text once read, so Select Text after a failed Copy (or the reverse) does not read it twice.
     */
    const wholeText = useRef<string>(undefined);
    const run = async (action: Busy, then: (text: string) => Promise<void> | void) => {
        setBusy(action);
        setError(undefined);
        let text: string;
        try {
            text = wholeText.current ?? (await readText());
            wholeText.current = text;
        } catch {
            setBusy(undefined);
            setError(t('conversation.message.readFailed'));
            return;
        }
        try {
            await then(text);
        } catch {
            setError(t('conversation.message.copyFailed'));
        }
        setBusy(undefined);
    };
    return (
        <BottomSheet
            closeLabel={t('conversation.message.close')}
            maxHeight="80%"
            onClose={onClose}
            testID="conversation-message-sheet"
            theme={theme}
        >
            {(dismiss) =>
                selectText === undefined ? (
                    <View style={styles.actions}>
                        <SheetAction
                            busy={busy === 'copy'}
                            disabled={busy !== undefined}
                            icon={Copy}
                            label={t('conversation.message.copy')}
                            onPress={() => {
                                void run('copy', async (text) => {
                                    await Clipboard.setStringAsync(text);
                                    dismiss();
                                });
                            }}
                            testID="conversation-message-copy"
                            theme={theme}
                        />
                        <SheetAction
                            busy={busy === 'select'}
                            disabled={busy !== undefined}
                            icon={TextCursor}
                            label={t('conversation.message.selectText')}
                            onPress={() => {
                                void run('select', setSelectText);
                            }}
                            testID="conversation-message-select"
                            theme={theme}
                        />
                        {edit ? (
                            <>
                                <SheetAction
                                    busy={busy === 'edit'}
                                    disabled={busy !== undefined || !edit.availability.canEdit}
                                    icon={Pencil}
                                    label={t('chat.edit.fromHere')}
                                    onPress={() => {
                                        void run('edit', (text) => {
                                            edit.onEdit(text);
                                            dismiss();
                                        });
                                    }}
                                    testID="conversation-message-edit"
                                    theme={theme}
                                />
                                {edit.availability.canEdit ? null : (
                                    <Text
                                        style={[styles.note, { color: theme.muted }]}
                                        testID="conversation-message-edit-reason"
                                    >
                                        {edit.availability.reason}
                                    </Text>
                                )}
                            </>
                        ) : null}
                        {error ? (
                            <Text
                                accessibilityRole="alert"
                                style={[styles.note, { color: theme.danger }]}
                                testID="conversation-message-error"
                            >
                                {error}
                            </Text>
                        ) : null}
                        <SheetCancel
                            onPress={dismiss}
                            testID="conversation-message-cancel"
                            theme={theme}
                        />
                    </View>
                ) : (
                    <View style={styles.select}>
                        <Text style={[styles.title, { color: theme.text }]}>
                            {t('conversation.message.selectTitle')}
                        </Text>
                        <ScrollView
                            style={[styles.textBox, { borderColor: theme.border }]}
                            testID="conversation-message-select-scroll"
                        >
                            <Text
                                selectable
                                style={[styles.text, { color: theme.text }]}
                                testID="conversation-message-select-text"
                            >
                                {selectText}
                            </Text>
                        </ScrollView>
                        <SheetCancel
                            label="Done"
                            onPress={dismiss}
                            testID="conversation-message-select-done"
                            theme={theme}
                        />
                    </View>
                )
            }
        </BottomSheet>
    );
};

const styles = StyleSheet.create({
    actions: { gap: 4 },
    note: { fontSize: 13, lineHeight: 18, paddingBottom: 6, paddingHorizontal: 44 },
    select: { flexShrink: 1, gap: 10 },
    title: { fontSize: 16, fontWeight: '600', paddingHorizontal: 4 },
    textBox: {
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        flexShrink: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    text: { fontSize: 15, lineHeight: 23 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
