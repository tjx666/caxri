import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import { mobileUpdateSizeLabel, mobileUpdateStatusLabel } from './mobile-update-state';
import { useMobileUpdate } from './use-mobile-update';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
/**
 * Offers the newer Android build bundled with the paired Desktop. It stays out of the way: one row, dismissible for the
 * app session, and Settings keeps the same action after "Later".
 */
export const MobileUpdateBanner = ({ theme }: { theme: MobileTheme }) => {
    const { dismiss, install, isDismissed, phase, update } = useMobileUpdate();
    if (!update || (isDismissed && phase.kind === 'idle')) return null;
    const isBusy = phase.kind === 'downloading' || phase.kind === 'installing';
    const detail =
        mobileUpdateStatusLabel(phase) ??
        `Version ${update.version} from your computer · ${mobileUpdateSizeLabel(update.sizeBytes)}`;
    return (
        <View
            style={[styles.banner, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID="mobile-update-banner"
        >
            <View accessible style={styles.copy}>
                <Text style={[styles.title, { color: theme.text }]}>Update available</Text>
                <Text
                    style={[
                        styles.body,
                        { color: phase.kind === 'failed' ? theme.danger : theme.muted },
                    ]}
                >
                    {detail}
                </Text>
            </View>
            {isBusy ? null : (
                <>
                    <Pressable
                        accessibilityRole="button"
                        onPress={dismiss}
                        style={styles.action}
                        testID="mobile-update-later"
                    >
                        <Text style={[styles.actionLabel, { color: theme.muted }]}>Later</Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        onPress={install}
                        style={styles.action}
                        testID="mobile-update-install"
                    >
                        <Text style={[styles.actionLabel, { color: theme.primary }]}>
                            {phase.kind === 'failed' ? 'Retry' : 'Update'}
                        </Text>
                    </Pressable>
                </>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    banner: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: 4,
        paddingLeft: 16,
        paddingRight: 8,
        paddingVertical: 10,
    },
    body: { fontSize: 13, lineHeight: 18 },
    copy: { flex: 1, gap: 3 },
    action: { justifyContent: 'center', minHeight: 44, paddingHorizontal: 8 },
    actionLabel: { fontSize: 14, fontWeight: '700' },
    title: { fontSize: 14, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
