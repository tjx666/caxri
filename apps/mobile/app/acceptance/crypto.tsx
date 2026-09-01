import { Redirect } from 'expo-router';

import { CryptoVectorScreen } from '../../src/features/acceptance/crypto-vector-screen';

export default function CryptoVectorRoute() {
    /**
     * Expo inlines EXPO_PUBLIC values while bundling. Ordinary release builds therefore redirect before mounting the
     * Acceptance surface, while the guarded non-debuggable Acceptance build can execute the production crypto runtime.
     */
    // eslint-disable-next-line n/prefer-global/process -- Expo replaces EXPO_PUBLIC variables in the browser bundle.
    if (process.env.EXPO_PUBLIC_CAXRI_ACCEPTANCE !== '1') return <Redirect href="/" />;
    return <CryptoVectorScreen />;
}
