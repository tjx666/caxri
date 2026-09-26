import * as SecureStore from 'expo-secure-store';

import type { CredentialStorageAdapter } from './credential-store';
import { createMobileCredentialStore } from './credential-store';

const injectedReadFaults = new Set<string>();
/**
 * A build-time Acceptance fault runs only after a real credential exists and leaves it untouched.
 */
const storage: CredentialStorageAdapter = {
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
    getItemAsync: async (key) => {
        const value = await SecureStore.getItemAsync(key);
        if (
            value !== null &&
            !injectedReadFaults.has('storage-read-once') &&
            // Expo replaces this expression while bundling the acceptance build.
            // eslint-disable-next-line n/prefer-global/process
            process.env.EXPO_PUBLIC_CAXRI_ACCEPTANCE_FAULT === 'storage-read-once'
        ) {
            injectedReadFaults.add('storage-read-once');
            throw new Error('Acceptance credential read fault');
        }
        return value;
    },
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
};

export const expoMobileCredentialStore = createMobileCredentialStore(storage);
