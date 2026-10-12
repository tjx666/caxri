import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    allowAuthenticatedLanWebSockets,
    describeIosLocalNetworkAccess,
} from '../with-mobile-network-policy';

interface ExpoPluginResolver {
    resolveConfigPluginFunction: (projectRoot: string, pluginReference: string) => unknown;
}

const projectRequire = createRequire(import.meta.url);
const expoRequire = createRequire(projectRequire.resolve('expo/package.json'));
const { resolveConfigPluginFunction } = expoRequire(
    '@expo/config-plugins/build/utils/plugin-resolver',
) as ExpoPluginResolver;
const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('withMobileNetworkPolicy', () => {
    it('can be compiled and loaded by the Expo config-plugin resolver', () => {
        expect(() =>
            resolveConfigPluginFunction(mobileRoot, './plugins/with-mobile-network-policy'),
        ).not.toThrow();
    });

    it('allows the authenticated local WebSocket transport in Android release manifests', () => {
        const manifest = {
            manifest: {
                $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
                queries: [],
                application: [{ $: { 'android:name': '.MainApplication' as const } }],
            },
        };
        expect(
            allowAuthenticatedLanWebSockets(manifest).manifest.application?.[0]?.$[
                'android:usesCleartextTraffic'
            ],
        ).toBe('true');
    });

    it('ships a product-specific iOS local-network explanation', () => {
        expect(describeIosLocalNetworkAccess({})).toMatchObject({
            NSLocalNetworkUsageDescription:
                'Allow Caxri to connect securely to your computer on the local network.',
            NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
        });
    });
});
