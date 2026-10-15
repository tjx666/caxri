import { useWindowDimensions } from 'react-native';

import { Redirect, Stack, useLocalSearchParams } from 'expo-router';

import { LoadingScreen } from '../../../src/components/loading-screen';
import { useMobileClient } from '../../../src/features/connection/mobile-client-provider';
import { mobileLayoutMode } from '../../../src/features/layout/layout-mode';
import { HostSessionsProvider } from '../../../src/features/sessions/components/host-sessions-provider';
import { useTranslation } from '../../../src/i18n';

export default function HostLayout() {
    const { 'host-id': hostId } = useLocalSearchParams<{ 'host-id': string }>();
    const client = useMobileClient();
    const { t } = useTranslation();
    const { height, width } = useWindowDimensions();
    if (client.status === 'booting') return <LoadingScreen label={t('screens.openingCaxri')} />;
    if (!client.paired || !client.hostId) return <Redirect href="/" />;
    if (hostId !== client.hostId)
        return <Redirect href={`/h/${encodeURIComponent(client.hostId)}`} />;
    /**
     * A tablet keeps the Session list beside the detail, so choosing another Session only swaps the right pane. Sliding
     * the whole split view in would read as leaving the list.
     */
    const sessionAnimation =
        mobileLayoutMode(width, height) === 'phone' ? 'ios_from_right' : 'none';
    return (
        <HostSessionsProvider hostId={hostId} key={client.connectionScopeKey}>
            <Stack screenOptions={{ animation: 'ios_from_right', headerShown: false }}>
                {/* Returning to the list without history replaces the detail, which must still read as going back. */}
                <Stack.Screen
                    name="index"
                    options={{ animation: sessionAnimation, animationTypeForReplace: 'pop' }}
                />
                <Stack.Screen name="s/[session-id]" options={{ animation: sessionAnimation }} />
                <Stack.Screen name="new" options={{ animation: 'slide_from_bottom' }} />
            </Stack>
        </HostSessionsProvider>
    );
}

export { RouteErrorScreen as ErrorBoundary } from '../../../src/components/route-error-screen';
