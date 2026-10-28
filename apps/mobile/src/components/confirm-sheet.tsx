/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '../i18n';
import { mobileSpace } from '../theme/scale';
import type { MobileTheme } from '../theme/tokens';
import { BottomSheet, SheetCancel, SheetTitle } from './bottom-sheet';
import { Button } from './button';

/**
 * The app's one confirmation: a sheet naming the consequence, a button labeled with the verb, and Cancel. It replaces
 * the platform `Alert`, which draws a light system dialog over the dark app and cannot show a busy state. `danger` is
 * only for an action that loses something (discarding an edit, forgetting the computer); a confirmation that only
 * interrupts work stays `primary`.
 *
 * Mount it only while it is open, like {@link BottomSheet}. Confirming dismisses the sheet before `onConfirm` runs.
 */
export const ConfirmSheet = ({
    confirmLabel,
    detail,
    onClose,
    onConfirm,
    testID,
    theme,
    title,
    tone,
}: {
    confirmLabel: string;
    /**
     * The consequence, in one or two sentences.
     */
    detail?: string;
    onClose: () => void;
    onConfirm: () => void;
    testID: string;
    theme: MobileTheme;
    title: string;
    tone: 'danger' | 'primary';
}) => {
    const { t } = useTranslation();
    return (
        <BottomSheet
            closeLabel={t('common.cancel')}
            onClose={onClose}
            testID={testID}
            theme={theme}
        >
            {(dismiss) => (
                <View style={styles.body}>
                    <SheetTitle detail={detail} theme={theme} title={title} />
                    <Button
                        label={confirmLabel}
                        onPress={() => {
                            onConfirm();
                            dismiss();
                        }}
                        testID={`${testID}-confirm`}
                        theme={theme}
                        variant={tone}
                    />
                    <SheetCancel onPress={dismiss} testID={`${testID}-cancel`} theme={theme} />
                </View>
            )}
        </BottomSheet>
    );
};

const styles = StyleSheet.create({
    body: { gap: mobileSpace.xs },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
