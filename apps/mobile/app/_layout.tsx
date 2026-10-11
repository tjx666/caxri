import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ErrorBoundaryProps } from 'expo-router';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { RouteErrorScreen } from '../src/components/route-error-screen';
import { MobileClientProvider } from '../src/features/connection/mobile-client-provider';
import { expoReadCache } from '../src/features/read-cache/expo-read-cache';
import { ReadCacheContext } from '../src/features/read-cache/read-cache-context';

const styles = StyleSheet.create({ root: { flex: 1 } });

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
    const [queryClient] = useState(() => new QueryClient());
    return (
        <GestureHandlerRootView style={styles.root}>
            <SafeAreaProvider>
                <QueryClientProvider client={queryClient}>
                    <ReadCacheContext.Provider value={expoReadCache}>
                        <MobileClientProvider>
                            <StatusBar style="light" />
                            <Stack
                                screenOptions={{ animation: 'ios_from_right', headerShown: false }}
                            >
                                {/* Boot and pairing redirects land on the host; sliding a whole new app in reads as a jump. */}
                                <Stack.Screen name="h/[host-id]" options={{ animation: 'fade' }} />
                                <Stack.Screen name="sessions" options={{ animation: 'none' }} />
                            </Stack>
                        </MobileClientProvider>
                    </ReadCacheContext.Provider>
                </QueryClientProvider>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
}
