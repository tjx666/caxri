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
            <Pressable accessibilityRole="button" hitSlop={8} onPress={onRetry}>
                <Text style={[styles.retry, { color: theme.primary }]}>Retry</Text>
            </Pressable>
        ) : null}
    </View>
);
