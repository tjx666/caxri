import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { mobileUpdateSizeLabel, mobileUpdateStatusLabel } from './mobile-update-state';
import type { MobileUpdate } from './use-mobile-update';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
/**
 * The Settings entry for the update the Sessions banner offers; it ignores the banner's "Later" on purpose.
 */
export const MobileUpdateSettingsRow = ({
    mobileUpdate: { install, phase, update },
    theme,
}: {
    mobileUpdate: MobileUpdate & { update: NonNullable<MobileUpdate['update']> };
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isBusy = phase.kind === 'downloading' || phase.kind === 'installing';
    const status = mobileUpdateStatusLabel(phase, t);
    return (
        <Pressable
            accessibilityHint={t('update.settingsRowHint')}
            accessibilityRole="button"
            accessibilityState={{ busy: isBusy, disabled: isBusy }}
            disabled={isBusy}
            onPress={install}
            style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? theme.elevated : 'transparent' },
            ]}
            testID="settings-app-update"
        >
            <View style={styles.main}>
                <Text style={[styles.label, { color: theme.primary }]}>
                    {phase.kind === 'failed'
                        ? t('update.retryUpdate')
                        : t('update.updateTo', { version: update.version })}
                </Text>
                <Text style={[styles.value, { color: theme.muted }]}>
                    {mobileUpdateSizeLabel(update.sizeBytes)}
                </Text>
            </View>
            {status ? (
                <Text
                    style={[
                        styles.detail,
                        { color: phase.kind === 'failed' ? theme.danger : theme.muted },
                    ]}
                >
                    {status}
                </Text>
            ) : null}
        </Pressable>
    );
};

const styles = StyleSheet.create({
    row: {
        gap: 4,
        minHeight: 52,
        justifyContent: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    main: { alignItems: 'center', flexDirection: 'row', gap: 12 },
    label: { flex: 1, fontSize: 15, fontWeight: '600' },
    value: { fontSize: 15 },
    detail: { fontSize: 13, lineHeight: 18 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
