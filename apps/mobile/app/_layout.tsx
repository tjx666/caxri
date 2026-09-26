import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { MobileClientProvider } from '../src/features/connection/mobile-client-provider';

const injectedRenderFaults = new Set<string>();

export default function RootLayout() {
    /**
     * Acceptance exercises Expo Router's root retry with one render-only failure.
     */
    if (
        !injectedRenderFaults.has('render-once') &&
        // Expo replaces this expression while bundling the acceptance build.
        // eslint-disable-next-line n/prefer-global/process
        process.env.EXPO_PUBLIC_CAXRI_ACCEPTANCE_FAULT === 'render-once'
    ) {
        injectedRenderFaults.add('render-once');
        throw new Error('Acceptance route render fault');
    }
    const [queryClient] = useState(() => new QueryClient());
    return (
        <SafeAreaProvider>
            <QueryClientProvider client={queryClient}>
                <MobileClientProvider>
                    <StatusBar style="light" />
                    <Stack screenOptions={{ headerShown: false }} />
                </MobileClientProvider>
            </QueryClientProvider>
        </SafeAreaProvider>
    );
}

export { RouteErrorScreen as ErrorBoundary } from '../src/components/route-error-screen';
