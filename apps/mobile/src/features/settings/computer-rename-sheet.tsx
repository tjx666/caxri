/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { BottomSheet, SheetTitle } from '../../components/bottom-sheet';
import { Button } from '../../components/button';
import { useTranslation } from '../../i18n';
import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import { mobileErrorMessage } from '../connection/mobile-error-message';
import { useHostSessions } from '../sessions/components/host-sessions-provider';
import { COMPUTER_NAME_MAX_LENGTH, computerRenameDraft } from './settings-model';

/**
 * Renames the paired computer for every phone paired with it (`mobile.computerName` on the Server). An empty field goes
 * back to the system host name. Mount it only while open, like {@link BottomSheet}.
 */
export const ComputerRenameSheet = ({
    currentName,
    onClose,
    theme,
}: {
    currentName: string;
    onClose: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { request } = useMobileClient();
    const { sessions } = useHostSessions();
    const [draft, setDraft] = useState(currentName);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const change = computerRenameDraft(draft, currentName);
    const save = async (dismiss: () => void): Promise<void> => {
        if (!change || isSaving) return;
        setIsSaving(true);
        setError(null);
        try {
            const renamed = await request('mobile.computer.rename', change);
            sessions.showHostDisplayName(renamed.hostDisplayName);
            await sessions.refresh();
            dismiss();
        } catch (error_) {
            // Shown inline: on Android this sheet's Modal sits above the root ToastHost, so a toast would be invisible.
            setError(mobileErrorMessage(error_, t('settings.rename.failed'), t));
        } finally {
            setIsSaving(false);
        }
    };
    return (
        <BottomSheet
            closeLabel={t('common.cancel')}
            onClose={onClose}
            testID="computer-rename-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <View style={styles.body}>
                    <SheetTitle
                        detail={t('settings.rename.detail')}
                        theme={theme}
                        title={t('settings.rename.title')}
                    />
                    <TextInput
                        accessibilityLabel={t('settings.name')}
                        autoFocus
                        maxLength={COMPUTER_NAME_MAX_LENGTH}
                        onChangeText={(text) => {
                            setDraft(text);
                            setError(null);
                        }}
                        onSubmitEditing={() => {
                            void save(dismiss);
                        }}
                        placeholder={t('settings.name')}
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
                        testID="computer-rename-input"
                        value={draft}
                    />
                    {error ? (
                        <Text
                            accessibilityLiveRegion="polite"
                            style={[styles.error, { color: theme.danger }]}
                            testID="computer-rename-error"
                        >
                            {error}
                        </Text>
                    ) : null}
                    <View style={styles.buttons}>
                        <Button
                            label={t('common.cancel')}
                            onPress={dismiss}
                            style={styles.button}
                            testID="computer-rename-cancel"
                            theme={theme}
                            variant="outline"
                        />
                        <Button
                            isBusy={isSaving}
                            isDisabled={!change}
                            label={t('settings.rename.save')}
                            onPress={() => {
                                void save(dismiss);
                            }}
                            style={styles.button}
                            testID="computer-rename-save"
                            theme={theme}
                            variant="primary"
                        />
                    </View>
                </View>
            )}
        </BottomSheet>
    );
};

const styles = StyleSheet.create({
    body: { gap: mobileSpace.md },
    input: {
        ...mobileType.body,
        borderRadius: mobileRadius.md,
        borderWidth: 1,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.lg,
    },
    error: mobileType.meta,
    buttons: { flexDirection: 'row', gap: mobileSpace.md },
    button: { flex: 1 },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
