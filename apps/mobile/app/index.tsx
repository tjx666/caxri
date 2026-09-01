import { Redirect } from 'expo-router';

import { LoadingScreen } from '../src/components/loading-screen';
import { useMobileClient } from '../src/features/connection/mobile-client-provider';
import { PairingEntryScreen } from '../src/features/pairing/components/pairing-entry-screen';

export default function IndexRoute() {
    const client = useMobileClient();
    if (client.status === 'booting') return <LoadingScreen label="Opening Caxri…" />;
    if (client.paired) return <Redirect href="/sessions" />;
    return <PairingEntryScreen />;
}
