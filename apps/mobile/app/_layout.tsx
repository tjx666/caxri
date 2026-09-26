import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ErrorBoundaryProps } from 'expo-router';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { RouteErrorScreen } from '../src/components/route-error-screen';
import { MobileClientProvider } from '../src/features/connection/mobile-client-provider';

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
