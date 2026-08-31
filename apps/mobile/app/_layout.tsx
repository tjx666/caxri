import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { MobileClientProvider } from '../src/features/connection/mobile-client-provider';

export default function RootLayout() {
    return (
        <SafeAreaProvider>
            <MobileClientProvider>
                <StatusBar style="light" />
                <Stack screenOptions={{ headerShown: false }} />
            </MobileClientProvider>
        </SafeAreaProvider>
    );
}
