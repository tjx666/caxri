import { StyleSheet, Text, View } from 'react-native';

import { router } from 'expo-router';

import { Button } from '../../../components/button';
import { Spinner } from '../../../components/spinner';
import { useTranslation } from '../../../i18n';
import { mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';

const styles = StyleSheet.create({
    root: {
        alignItems: 'center',
        flex: 1,
        gap: mobileSpace.md,
        justifyContent: 'center',
        padding: mobileSpace.xl,
    },
    body: { ...mobileType.body, textAlign: 'center' },
    action: { minWidth: 160 },
});

export const SessionRouteStatus = ({
    error,
    hasBack,
    hostId,
    isLoading,
    isOffline,
    onRetry,
    theme,
}: {
    error: string | null;
    /**
     * A phone has no Session list beside this screen, so a dead end needs its own way back.
     */
    hasBack: boolean;
    hostId: string;
    isLoading: boolean;
    isOffline: boolean;
    onRetry: () => Promise<unknown>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View style={styles.root} testID="session-route-status">
            {isLoading && !error && !isOffline ? <Spinner color={theme.primary} /> : null}
            <Text
                accessibilityRole={error ? 'alert' : 'text'}
                style={[styles.body, { color: theme.muted }]}
            >
                {error ?? t(isOffline ? 'sessions.route.reconnect' : 'sessions.route.opening')}
            </Text>
            {error ? (
                <Button
                    label={t('common.retry')}
                    onPress={() => {
                        void onRetry();
                    }}
                    style={styles.action}
                    testID="session-route-retry"
                    theme={theme}
                    variant="outline"
                />
            ) : null}
            {hasBack && (error || isOffline) ? (
                <Button
                    label={t('sessions.backToSessions')}
                    onPress={() => router.dismissTo(`/h/${encodeURIComponent(hostId)}`)}
                    style={styles.action}
                    testID="session-route-back"
                    theme={theme}
                    variant="outline"
                />
            ) : null}
        </View>
    );
};
