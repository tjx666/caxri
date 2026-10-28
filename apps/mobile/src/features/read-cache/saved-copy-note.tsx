import { StyleSheet, Text, View } from 'react-native';

import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useSavedAge } from './use-saved-age';

const styles = StyleSheet.create({
    note: { paddingHorizontal: mobileSpace.lg, paddingVertical: mobileSpace.sm },
    text: { ...mobileType.caption, fontVariant: ['tabular-nums'], textAlign: 'center' },
});

/**
 * Tells the reader the messages above are the copy this phone saved, not a live read; renders nothing once live.
 */
export const SavedCopyNote = ({
    savedAt,
    testID,
    theme,
}: {
    savedAt: number | undefined;
    testID: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const age = useSavedAge(savedAt ?? null);
    if (age === null) return null;
    return (
        <View style={styles.note} testID={testID}>
            <Text style={[styles.text, { color: theme.muted }]}>
                {t('sessions.savedCopy.messages', { saved: age })}
            </Text>
        </View>
    );
};
