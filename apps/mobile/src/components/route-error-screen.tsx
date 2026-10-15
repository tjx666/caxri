/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import type { ErrorBoundaryProps } from 'expo-router';

import { useTranslation } from '../i18n';
import { useMobileTheme } from '../theme/use-mobile-theme';
import { ActionButton } from './action-button';

/**
 * Replaces Expo Router's default error screen, which prints the raw error message and stack. Those can carry Session,
 * path, or Terminal details, so this screen never renders the error itself. It brings its own safe-area provider
 * because the root boundary renders in place of the layout that normally supplies one.
 */
export const RouteErrorScreen = ({ retry }: ErrorBoundaryProps) => {
    const theme = useMobileTheme();
    const { t } = useTranslation();
    return (
        <SafeAreaProvider>
            <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
                <View style={styles.content} testID="route-error-screen">
                    <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
                        {t('components.routeError.title')}
                    </Text>
                    <Text style={[styles.body, { color: theme.muted }]}>
                        {t('components.routeError.body')}
                    </Text>
                    <ActionButton
                        accessibilityHint={t('components.routeError.retryHint')}
                        onPress={() => {
                            // eslint-disable-next-line no-void -- A failed retry renders this screen again.
                            void retry();
                        }}
                        testID="route-error-retry"
                        theme={theme}
                    >
                        {t('components.tryAgain')}
                    </ActionButton>
                </View>
            </SafeAreaView>
        </SafeAreaProvider>
    );
};

const styles = StyleSheet.create({
    body: {
        fontSize: 15,
        lineHeight: 22,
    },
    content: {
        alignSelf: 'center',
        flex: 1,
        gap: 14,
        justifyContent: 'center',
        maxWidth: 520,
        padding: 24,
        width: '100%',
    },
    safeArea: {
        flex: 1,
    },
    title: {
        fontSize: 22,
        fontWeight: '700',
        lineHeight: 28,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
