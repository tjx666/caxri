import { Platform } from 'react-native';

import * as Crypto from 'expo-crypto';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';

import type { MobileGatewayRuntime } from './mobile-gateway-client';
import { createMobileRouteHints } from './route-hints';

export const expoMobileGatewayRuntime: MobileGatewayRuntime = {
    isCellular: async () =>
        (await Network.getNetworkStateAsync()).type === Network.NetworkStateType.CELLULAR,
    openWebSocket: (url) => new WebSocket(url),
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    randomBytes: (length) => Crypto.getRandomBytes(length),
    routeHints: createMobileRouteHints({
        getItemAsync: (key) => SecureStore.getItemAsync(key),
        setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
    }),
};
