import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import { mobileUpdateBannerKind, mobileUpdateBannerView } from './mobile-update-state';
import { useMobileUpdate } from './use-mobile-update';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
/**
 * A version mismatch with no build to offer: the phone is newer than Desktop, recovery is unavailable, or Desktop ships
 * no APK. Nothing on the phone can fix it, so the row only explains.
 */
const MobileVersionMismatchBanner = ({ theme }: { theme: MobileTheme }) => {
    const { t } = useTranslation();
    return (
        <View
            style={[styles.banner, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID="mobile-version-mismatch"
        >
            <View style={styles.copy}>
                <Text accessibilityRole="alert" style={[styles.title, { color: theme.text }]}>
                    {t('update.required')}
                </Text>
                <Text style={[styles.body, { color: theme.muted }]}>
                    {t('update.mismatchBody')}
                </Text>
            </View>
        </View>
    );
};

const MobileUpdateActions = ({
    actionLabel,
    onAction,
    onDismiss,
    theme,
}: {
    actionLabel: string;
    onAction: () => void;
    /**
     * Absent while the update is required: "Later" would leave the app unable to reconnect.
     */
    onDismiss?: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <>
            {onDismiss ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={onDismiss}
                    style={styles.action}
                    testID="mobile-update-later"
                >
                    <Text style={[styles.actionLabel, { color: theme.muted }]}>
                        {t('update.later')}
                    </Text>
                </Pressable>
            ) : null}
            <Pressable
                accessibilityRole="button"
                onPress={onAction}
                style={styles.action}
                testID="mobile-update-install"
            >
                <Text style={[styles.actionLabel, { color: theme.primary }]}>{actionLabel}</Text>
            </Pressable>
        </>
    );
};

/**
 * Offers the newer Android build bundled with the paired Desktop. While connected it stays out of the way: one row,
 * dismissible for the app session, and Settings keeps the same action after "Later". While a newer Desktop refuses this
 * app's version, the same row is the way back and cannot be dismissed; without a build to offer it only explains the
 * mismatch.
 */
export const MobileUpdateBanner = ({ theme }: { theme: MobileTheme }) => {
    const { status } = useMobileClient();
    const { t } = useTranslation();
    const {
        canRetryCheck,
        dismiss,
        install,
        isChecking,
        isDismissed,
        isRecovering,
        phase,
        retryCheck,
        update,
    } = useMobileUpdate();
    const kind = mobileUpdateBannerKind({
        canRetryCheck,
        isChecking,
        isDismissed,
        isRecovering,
        phase,
        status,
        update,
    });
    if (!kind) return null;
    if (kind === 'mismatch') return <MobileVersionMismatchBanner theme={theme} />;
    const view = mobileUpdateBannerView(kind, phase, update, t);
    return (
        <View
            style={[styles.banner, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID={view.isRequired ? 'mobile-update-required' : 'mobile-update-banner'}
        >
            <View accessible style={styles.copy}>
                <Text
                    accessibilityRole={view.isRequired ? 'alert' : undefined}
                    style={[styles.title, { color: theme.text }]}
                >
                    {view.title}
                </Text>
                <Text style={[styles.body, { color: view.isFailure ? theme.danger : theme.muted }]}>
                    {view.detail}
                </Text>
            </View>
            {view.action ? (
                <MobileUpdateActions
                    actionLabel={view.actionLabel}
                    onAction={view.action === 'retry-check' ? retryCheck : install}
                    onDismiss={view.canDismiss ? dismiss : undefined}
                    theme={theme}
                />
            ) : null}
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
