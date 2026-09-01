import { useLocalSearchParams } from 'expo-router';

import { PairingLinkScreen } from '../../src/features/pairing/components/pairing-link-screen';

export default function PairRoute() {
    return <PairingLinkScreen parameters={useLocalSearchParams()} />;
}
