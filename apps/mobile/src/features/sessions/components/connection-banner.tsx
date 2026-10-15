import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileConnectionStatus } from '../../connection/connection-state';
import { connectionBannerCopy } from '../session-notices';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
export const ConnectionBanner = ({
    isSavedCopyLabeled,
    onRetry,
    status,
    theme,
}: {
    /**
     * Whether the screen below labels the saved copy it shows, so the banner need not say it again.
     */
    isSavedCopyLabeled: boolean;
    onRetry: () => void;
    status: Extract<MobileConnectionStatus, 'stale' | 'unverified'>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const copy = connectionBannerCopy(status, isSavedCopyLabeled, t);
    return (
        <View
            style={[styles.banner, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID="connection-stale-banner"
        >
            <View accessible accessibilityLabel={copy.accessibilityLabel} style={styles.copy}>
                <Text style={[styles.title, { color: theme.text }]}>{copy.title}</Text>
                <Text style={[styles.body, { color: theme.muted }]}>{copy.body}</Text>
            </View>
            {status === 'unverified' ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={onRetry}
                    style={styles.retry}
                    testID="connection-retry-button"
                >
                    <Text style={[styles.retryLabel, { color: theme.primary }]}>
                        {t('common.retry')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    banner: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: 12,
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    body: { fontSize: 13, lineHeight: 18 },
    copy: { flex: 1, gap: 3 },
    retry: { justifyContent: 'center', minHeight: 48, paddingHorizontal: 8 },
    retryLabel: { fontSize: 14, fontWeight: '700' },
    title: { fontSize: 14, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
