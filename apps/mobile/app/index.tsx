import { Redirect } from 'expo-router';

import { LoadingScreen } from '../src/components/loading-screen';
import { useMobileClient } from '../src/features/connection/mobile-client-provider';
import { PairingEntryScreen } from '../src/features/pairing/components/pairing-entry-screen';
import { useTranslation } from '../src/i18n';

export default function IndexRoute() {
    const client = useMobileClient();
    const { t } = useTranslation();
    if (client.status === 'booting') return <LoadingScreen label={t('screens.openingCaxri')} />;
    if (client.hostId) return <Redirect href={`/h/${encodeURIComponent(client.hostId)}`} />;
    return <PairingEntryScreen />;
}
