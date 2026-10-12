import type { ConfigPlugin, InfoPlist } from 'expo/config-plugins';
import { AndroidConfig, withAndroidManifest, withInfoPlist } from 'expo/config-plugins';

type AndroidManifest = Parameters<typeof AndroidConfig.Manifest.getMainApplicationOrThrow>[0];

const LOCAL_NETWORK_DESCRIPTION =
    'Allow Caxri to connect securely to your computer on the local network.';

/**
 * Caxri's LAN transport uses `ws://` because TLS certificates cannot name a changing private IP. The application
 * payload remains mutually authenticated and encrypted with transcript-bound AES-GCM before any command is accepted.
 */
export const allowAuthenticatedLanWebSockets = (manifest: AndroidManifest): AndroidManifest => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    app.$['android:usesCleartextTraffic'] = 'true';
    return manifest;
};

export const describeIosLocalNetworkAccess = (info: InfoPlist): InfoPlist => ({
    ...info,
    NSLocalNetworkUsageDescription: LOCAL_NETWORK_DESCRIPTION,
    NSAppTransportSecurity: {
        ...(info.NSAppTransportSecurity as Record<string, unknown> | undefined),
        NSAllowsLocalNetworking: true,
    },
});

const withMobileNetworkPolicy: ConfigPlugin = (config) => {
    const android = withAndroidManifest(config, (config_) => {
        config_.modResults = allowAuthenticatedLanWebSockets(config_.modResults);
        return config_;
    });
    return withInfoPlist(android, (config_) => {
        config_.modResults = describeIosLocalNetworkAccess(config_.modResults);
        return config_;
    });
};

export default withMobileNetworkPolicy;
