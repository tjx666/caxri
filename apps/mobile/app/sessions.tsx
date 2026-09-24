import { Redirect } from 'expo-router';

import { useMobileClient } from '../src/features/connection/mobile-client-provider';

export default function SessionsRoute() {
    const { hostId } = useMobileClient();
    return <Redirect href={hostId ? `/h/${encodeURIComponent(hostId)}` : '/'} />;
}
