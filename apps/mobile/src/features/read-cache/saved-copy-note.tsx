import { StyleSheet, Text, View } from 'react-native';

import { useTranslation } from '../../i18n';
import { mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useSavedAge } from './use-saved-age';

const styles = StyleSheet.create({
    note: {
        alignItems: 'center',
        left: 0,
        paddingTop: mobileSpace.sm,
        position: 'absolute',
        right: 0,
        top: 0,
    },
    pill: {
        borderRadius: mobileRadius.pill,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.xs,
    },
    text: { ...mobileType.caption, fontVariant: ['tabular-nums'], textAlign: 'center' },
});

/**
 * Tells the reader the messages below are the copy this phone saved, not a live read; renders nothing once live. It
 * floats over the top of the timeline instead of taking a row above it: the note leaves as the first live read lands,
 * and as a row it pulled every message up by its height in that same moment. Place it inside a positioned container
 * that wraps the timeline.
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
        <View pointerEvents="none" style={styles.note} testID={testID}>
            <View
                style={[
                    styles.pill,
                    { backgroundColor: theme.elevated, borderColor: theme.border },
                ]}
            >
                <Text style={[styles.text, { color: theme.muted }]}>
                    {t('sessions.savedCopy.messages', { saved: age })}
                </Text>
            </View>
        </View>
    );
};
