import { Redirect } from 'expo-router';

import { BarcodeVectorScreen } from '../../src/features/acceptance/barcode-vector-screen';

export default function BarcodeVectorRoute() {
    /**
     * Expo inlines EXPO_PUBLIC values while bundling, so ordinary release builds redirect before mounting this
     * Acceptance surface, like the crypto vector route.
     */
    // eslint-disable-next-line n/prefer-global/process -- Expo replaces EXPO_PUBLIC variables in the browser bundle.
    if (process.env.EXPO_PUBLIC_CAXRI_ACCEPTANCE !== '1') return <Redirect href="/" />;
    return <BarcodeVectorScreen />;
}
