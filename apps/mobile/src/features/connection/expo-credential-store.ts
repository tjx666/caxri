import * as SecureStore from 'expo-secure-store';

import { createMobileCredentialStore } from './credential-store';

export const expoMobileCredentialStore = createMobileCredentialStore(SecureStore);
