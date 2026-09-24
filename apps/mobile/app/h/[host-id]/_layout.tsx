import { Redirect, Slot, useLocalSearchParams } from 'expo-router';

import { LoadingScreen } from '../../../src/components/loading-screen';
import { useMobileClient } from '../../../src/features/connection/mobile-client-provider';
import { HostSessionsProvider } from '../../../src/features/sessions/components/host-sessions-provider';

export default function HostLayout() {
    const { 'host-id': hostId } = useLocalSearchParams<{ 'host-id': string }>();
    const client = useMobileClient();
    if (client.status === 'booting') return <LoadingScreen label="Opening Caxri…" />;
    if (!client.paired || !client.hostId) return <Redirect href="/" />;
    if (hostId !== client.hostId)
        return <Redirect href={`/h/${encodeURIComponent(client.hostId)}`} />;
    return (
        <HostSessionsProvider hostId={hostId} key={client.connectionScopeKey}>
            <Slot />
        </HostSessionsProvider>
    );
}
