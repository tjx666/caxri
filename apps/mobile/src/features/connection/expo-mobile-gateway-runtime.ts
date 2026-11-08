import { Platform } from 'react-native';

import * as Crypto from 'expo-crypto';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';

import { createMobileDirectEndpoints } from './direct-endpoint';
import { expoFrameCipher } from './expo-frame-cipher';
import type { MobileGatewayRuntime } from './mobile-gateway-client';
import { createMobileRouteHints } from './route-hints';
import { createMobileRoutePreferenceStore } from './route-preference';

export const expoMobileGatewayRuntime: MobileGatewayRuntime = {
    frameCipher: expoFrameCipher,
    isCellular: async () =>
        (await Network.getNetworkStateAsync()).type === Network.NetworkStateType.CELLULAR,
    openWebSocket: (url) => new WebSocket(url),
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    randomBytes: (length) => Crypto.getRandomBytes(length),
    routePreference: createMobileRoutePreferenceStore({
        getItemAsync: (key) => SecureStore.getItemAsync(key),
        setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
    }),
    directEndpoints: createMobileDirectEndpoints({
        getItemAsync: (key) => SecureStore.getItemAsync(key),
        setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
    }),
    routeHints: createMobileRouteHints({
        getItemAsync: (key) => SecureStore.getItemAsync(key),
        setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
    }),
};
