import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { MobileClientProvider } from '../src/features/connection/mobile-client-provider';

export default function RootLayout() {
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
