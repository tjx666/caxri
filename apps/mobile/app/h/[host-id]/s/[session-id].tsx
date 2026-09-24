import { useLocalSearchParams } from 'expo-router';

import { SessionsScreen } from '../../../../src/features/sessions/components/sessions-screen';

export default function HostSessionRoute() {
    const { 'session-id': sessionId } = useLocalSearchParams<{ 'session-id': string }>();
    return <SessionsScreen routeSessionId={sessionId} />;
}
