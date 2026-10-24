import { Pressable, Text, View } from 'react-native';

import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { panelsStyles as styles } from './panels-styles';

/**
 * Loading, empty, and error states share one centered block so every Panels view fails the same way. The loading
 * spinner waits `LOADING_REVEAL_DELAY_MS` before it draws, so opening a folder or expanding a tree item that answers at
 * once swaps straight to its entries instead of flashing a spinner.
 */
export const PanelStatus = ({
    isLoading,
    message,
    onRetry,
    testID,
    theme,
}: {
    isLoading?: boolean;
    message?: string;
    onRetry?: () => void;
    testID?: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View style={styles.status} testID={testID}>
            {isLoading ? <Spinner color={theme.muted} isDelayed /> : null}
            {message ? (
                <Text style={[styles.statusText, { color: theme.muted }]}>{message}</Text>
            ) : null}
            {onRetry ? (
                <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retryButton}>
                    <Text style={[styles.retry, { color: theme.primary }]}>
                        {t('common.retry')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
};

/**
 * A Panels read that has no data yet is either in flight or held back because the phone is offline or backgrounded.
 * TanStack reports the second as a pending query with an idle fetch, which would otherwise spin forever.
 */
export const PendingPanelStatus = ({
    fetchStatus,
    theme,
}: {
    fetchStatus: 'fetching' | 'idle' | 'paused';
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return fetchStatus === 'fetching' ? (
        <PanelStatus isLoading theme={theme} />
    ) : (
        <PanelStatus message={t('panels.offline')} testID="panels-offline" theme={theme} />
    );
};
