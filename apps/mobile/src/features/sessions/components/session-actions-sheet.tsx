/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { isPinnedSession } from '@caxri/protocol';
import { Archive, Pencil, Pin, PinOff } from 'lucide-react-native';

import {
    BottomSheet,
    SheetAction,
    SheetCancel,
    SheetTitle,
} from '../../../components/bottom-sheet';
import { Button } from '../../../components/button';
import { useTranslation } from '../../../i18n';
import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';
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
    const [draft, setDraft] = useState(session.title);
    const isBusy = management.pending?.sessionId === session.id;
    const nextTitle = sessionRenameDraft(draft, session.title);
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
                    <SheetTitle
                        detail={session.projectTitle}
                        theme={theme}
                        title={
                            mode === 'rename'
                                ? t('sessions.actions.renameTitle')
                                : sessionTitleForDisplay(session.title, t)
                        }
                    />
                    {mode === 'menu' ? (
                        <View style={styles.actions}>
                            <SheetAction
                                busy={isBusy && management.pending?.action === 'pin'}
                                icon={isPinned ? PinOff : Pin}
                                label={t(
                                    isPinned ? 'sessions.actions.unpin' : 'sessions.actions.pin',
                                )}
                                onPress={() => {
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
                                <Button
                                    label={t('common.cancel')}
                                    onPress={() => setMode('menu')}
                                    style={styles.button}
                                    testID="session-rename-cancel"
                                    theme={theme}
                                    variant="outline"
                                />
                                <Button
                                    isBusy={isBusy}
                                    isDisabled={nextTitle === null}
                                    label={t('sessions.actions.save')}
                                    onPress={() => {
                                        void submitRename();
                                    }}
                                    style={styles.button}
                                    testID="session-rename-save"
                                    theme={theme}
                                    variant="primary"
                                />
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
    actions: { paddingTop: mobileSpace.xs },
    rename: { gap: mobileSpace.md, paddingHorizontal: mobileSpace.sm, paddingTop: mobileSpace.sm },
    input: {
        ...mobileType.body,
        borderRadius: mobileRadius.md,
        borderWidth: 1,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.lg,
    },
    buttons: { flexDirection: 'row', gap: mobileSpace.md },
    button: { flex: 1 },
    error: { ...mobileType.meta, paddingHorizontal: mobileSpace.sm, paddingTop: mobileSpace.md },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
