import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import { panelsStyles as styles } from './panels-styles';

/**
 * Loading, empty, and error states share one centered block so every Panels view fails the same way.
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
}) => (
    <View style={styles.status} testID={testID}>
        {isLoading ? <ActivityIndicator color={theme.muted} /> : null}
        {message ? (
            <Text style={[styles.statusText, { color: theme.muted }]}>{message}</Text>
        ) : null}
        {onRetry ? (
            <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retryButton}>
                <Text style={[styles.retry, { color: theme.primary }]}>Retry</Text>
            </Pressable>
        ) : null}
    </View>
);

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
}) =>
    fetchStatus === 'fetching' ? (
        <PanelStatus isLoading theme={theme} />
    ) : (
        <PanelStatus
            message="Reconnect to browse this Project."
            testID="panels-offline"
            theme={theme}
        />
    );
