/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { isPinnedSession } from '@caxri/protocol';
import { Archive, Pencil, Pin, PinOff } from 'lucide-react-native';

import { BottomSheet, SheetAction, SheetCancel } from '../../../components/bottom-sheet';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { useSessionManagement } from '../hooks/use-session-management';
import { sessionRenameDraft } from '../session-management-model';
import type { MobileSessionItem } from '../session-model';
import { sessionTitleForDisplay } from '../session-row-model';

/**
 * Long-press actions for one Session row. Rename swaps the sheet body for an inline text field instead of stacking a
 * second modal, so the keyboard and focus stay in one surface.
 */
export const SessionActionsSheet = ({
    management,
    onClose,
    session,
    theme,
}: {
    management: ReturnType<typeof useSessionManagement>;
    onClose: () => void;
    session: MobileSessionItem | null;
    theme: MobileTheme;
}) =>
    session ? (
        // Keyed by Session so the rename draft and mode start fresh for each row.
        <SessionActionsBody
            key={session.id}
            management={management}
            onClose={onClose}
            session={session}
            theme={theme}
        />
    ) : null;

const SessionActionsBody = ({
    management,
    onClose,
    session,
    theme,
}: {
    management: ReturnType<typeof useSessionManagement>;
    onClose: () => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [mode, setMode] = useState<'menu' | 'rename'>('menu');
    const [draft, setDraft] = useState(session.displayTitle);
    const isBusy = management.pending?.sessionId === session.id;
    const nextTitle = sessionRenameDraft(draft, session.displayTitle);
    const isPinned = isPinnedSession(session);
    const submitRename = async (): Promise<void> => {
        if (nextTitle !== null && (await management.rename(session.id, nextTitle))) onClose();
    };
    return (
        <BottomSheet
            closeLabel={t('sessions.actions.close')}
            onClose={onClose}
            testID="session-actions-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <>
                    <Text numberOfLines={3} style={[styles.title, { color: theme.text }]}>
                        {mode === 'rename'
                            ? t('sessions.actions.renameTitle')
                            : sessionTitleForDisplay(session.displayTitle, t)}
                    </Text>
                    <Text numberOfLines={1} style={[styles.subtitle, { color: theme.muted }]}>
                        {session.projectTitle}
                    </Text>
                    {mode === 'menu' ? (
                        <View style={styles.actions}>
                            <SheetAction
                                busy={isBusy && management.pending?.action === 'pin'}
                                icon={isPinned ? PinOff : Pin}
                                label={t(
                                    isPinned ? 'sessions.actions.unpin' : 'sessions.actions.pin',
                                )}
                                onPress={() => {
                                    // eslint-disable-next-line no-void -- The hook renders pin failures.
                                    void management
                                        .setPinned(session.id, !isPinned)
                                        .then((done) => {
                                            if (done) onClose();
                                        });
                                }}
                                testID="session-action-pin"
                                theme={theme}
                            />
                            <SheetAction
                                busy={false}
                                icon={Pencil}
                                label={t('sessions.actions.rename')}
                                onPress={() => setMode('rename')}
                                testID="session-action-rename"
                                theme={theme}
                            />
                            <SheetAction
                                busy={isBusy && management.pending?.action === 'archive'}
                                icon={Archive}
                                label={t('sessions.actions.archive')}
                                onPress={() => {
                                    // eslint-disable-next-line no-void -- The hook renders archive failures.
                                    void management.archive(session.id).then((done) => {
                                        if (done) onClose();
                                    });
                                }}
                                testID="session-action-archive"
                                theme={theme}
                            />
                            <SheetCancel
                                onPress={dismiss}
                                testID="session-actions-cancel"
                                theme={theme}
                            />
                        </View>
                    ) : (
                        <View style={styles.rename}>
                            <TextInput
                                accessibilityLabel={t('sessions.actions.nameLabel')}
                                autoFocus
                                maxLength={200}
                                onChangeText={setDraft}
                                onSubmitEditing={() => {
                                    // eslint-disable-next-line no-void -- The hook renders rename failures.
                                    void submitRename();
                                }}
                                placeholder={t('sessions.actions.nameLabel')}
                                placeholderTextColor={theme.muted}
                                returnKeyType="done"
                                selectTextOnFocus
                                style={[
                                    styles.input,
                                    {
                                        backgroundColor: theme.background,
                                        borderColor: theme.border,
                                        color: theme.text,
                                    },
                                ]}
                                testID="session-rename-input"
                                value={draft}
                            />
                            <View style={styles.buttons}>
                                <Pressable
                                    accessibilityRole="button"
                                    onPress={() => setMode('menu')}
                                    style={[styles.button, { backgroundColor: theme.elevated }]}
                                    testID="session-rename-cancel"
                                >
                                    <Text style={[styles.buttonText, { color: theme.text }]}>
                                        {t('common.cancel')}
                                    </Text>
                                </Pressable>
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityState={{ disabled: nextTitle === null || isBusy }}
                                    disabled={nextTitle === null || isBusy}
                                    onPress={() => {
                                        // eslint-disable-next-line no-void -- The hook renders rename failures.
                                        void submitRename();
                                    }}
                                    style={[
                                        styles.button,
                                        {
                                            backgroundColor: theme.primary,
                                            opacity: nextTitle === null || isBusy ? 0.5 : 1,
                                        },
                                    ]}
                                    testID="session-rename-save"
                                >
                                    {isBusy ? (
                                        <ActivityIndicator
                                            color={theme.primaryForeground}
                                            size="small"
                                        />
                                    ) : (
                                        <Text
                                            style={[
                                                styles.buttonText,
                                                { color: theme.primaryForeground },
                                            ]}
                                        >
                                            {t('sessions.actions.save')}
                                        </Text>
                                    )}
                                </Pressable>
                            </View>
                        </View>
                    )}
                    {management.error ? (
                        <Text
                            accessibilityRole="alert"
                            style={[styles.error, { color: theme.danger }]}
                            testID="session-actions-error"
                        >
                            {management.error}
                        </Text>
                    ) : null}
                </>
            )}
        </BottomSheet>
    );
};

const styles = StyleSheet.create({
    title: { fontSize: 17, fontWeight: '700', paddingHorizontal: 8 },
    subtitle: { fontSize: 13, paddingBottom: 8, paddingHorizontal: 8, paddingTop: 2 },
    actions: { paddingTop: 4 },
    rename: { gap: 12, paddingHorizontal: 8, paddingTop: 8 },
    input: {
        borderRadius: 12,
        borderWidth: 1,
        fontSize: 16,
        minHeight: 48,
        paddingHorizontal: 14,
    },
    buttons: { flexDirection: 'row', gap: 10 },
    button: {
        alignItems: 'center',
        borderRadius: 12,
        flex: 1,
        justifyContent: 'center',
        minHeight: 48,
    },
    buttonText: { fontSize: 16, fontWeight: '700' },
    error: { fontSize: 13, paddingHorizontal: 8, paddingTop: 10 },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
