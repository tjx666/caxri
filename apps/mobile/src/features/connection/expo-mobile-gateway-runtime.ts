import { Platform } from 'react-native';

import * as Crypto from 'expo-crypto';

import type { MobileGatewayRuntime } from './mobile-gateway-client';

export const expoMobileGatewayRuntime: MobileGatewayRuntime = {
    openWebSocket: (url) => new WebSocket(url),
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    randomBytes: (length) => Crypto.getRandomBytes(length),
};
