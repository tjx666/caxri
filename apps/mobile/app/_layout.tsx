import { useEffect, useState } from 'react';
import { AppState, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ErrorBoundaryProps } from 'expo-router';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { RouteErrorScreen } from '../src/components/route-error-screen';
import { ToastHost } from '../src/components/toast';
import { MobileClientProvider } from '../src/features/connection/mobile-client-provider';
import { expoReadCache } from '../src/features/read-cache/expo-read-cache';
import { ReadCacheContext } from '../src/features/read-cache/read-cache-context';
import { syncSystemLocale } from '../src/i18n';
import { mobileNavigationColors } from '../src/theme/navigation-theme';
import { mobileTheme } from '../src/theme/tokens';

const styles = StyleSheet.create({ root: { flex: 1 } });

const navigationTheme = { ...DarkTheme, colors: mobileNavigationColors(mobileTheme) };

const acceptanceRenderFault = { isCleared: false };

function retryRootLayout(retry: ErrorBoundaryProps['retry']) {
    acceptanceRenderFault.isCleared = true;
    return retry();
}

export function ErrorBoundary(properties: ErrorBoundaryProps) {
    return <RouteErrorScreen {...properties} retry={() => retryRootLayout(properties.retry)} />;
}

export default function RootLayout() {
    /**
     * React can replay a failed render before committing its boundary. Keep the Acceptance fault active across those
     * replays until the user explicitly retries through the root error screen.
     */
    if (
        !acceptanceRenderFault.isCleared &&
        // Expo replaces this expression while bundling the acceptance build.
        // eslint-disable-next-line n/prefer-global/process
        process.env.EXPO_PUBLIC_CAXRI_ACCEPTANCE_FAULT === 'render-once'
    ) {
        throw new Error('Acceptance route render fault');
    }
    // Resolve the language before any screen renders, so the first paint is never English followed by a switch.
    useState(syncSystemLocale);
    const [queryClient] = useState(() => new QueryClient());
    // The reader can change the system language while Caxri is in the background; follow it on return.
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') syncSystemLocale();
        });
        return () => subscription.remove();
    }, []);
    return (
        <GestureHandlerRootView style={styles.root}>
            <SafeAreaProvider>
                <QueryClientProvider client={queryClient}>
                    <ReadCacheContext.Provider value={expoReadCache}>
                        <MobileClientProvider>
                            <StatusBar style="light" />
                            <ThemeProvider value={navigationTheme}>
                                <Stack
                                    screenOptions={{
                                        animation: 'ios_from_right',
                                        headerShown: false,
                                    }}
                                >
                                    {/* Boot and pairing redirects land on the host; sliding a whole new app in reads as a jump. */}
                                    <Stack.Screen
                                        name="h/[host-id]"
                                        options={{ animation: 'fade' }}
                                    />
                                    <Stack.Screen name="sessions" options={{ animation: 'none' }} />
                                    {/* The in-app browser slides over whatever opened it and returns there when closed. */}
                                    <Stack.Screen
                                        name="browser"
                                        options={{
                                            animation: 'slide_from_bottom',
                                            gestureEnabled: true,
                                            presentation: 'fullScreenModal',
                                        }}
                                    />
                                </Stack>
                            </ThemeProvider>
                            <ToastHost />
                        </MobileClientProvider>
                    </ReadCacheContext.Provider>
                </QueryClientProvider>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
}
