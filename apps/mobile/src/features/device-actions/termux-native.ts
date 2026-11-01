import { Platform } from 'react-native';

import { requireOptionalNativeModule } from 'expo';
import * as SecureStore from 'expo-secure-store';

import type { TermuxRunResult } from './device-action-handler';

interface CaxriTermuxModule {
    isInstalled(): boolean;
    hasPermission(): boolean;
    requestPermission(): Promise<{ granted: boolean }>;
    run(argv: string[], cwd: string | null, timeoutMs: number): Promise<TermuxRunResult>;
}

/**
 * The local module in `modules/caxri-termux`. It is absent on iOS and in a build without it, where Termux commands are
 * unsupported.
 */
const termuxModule =
    Platform.OS === 'android'
        ? requireOptionalNativeModule<CaxriTermuxModule>('CaxriTermux')
        : null;

const TERMUX_ENABLED_KEY = 'caxri.termux-commands-enabled.v1';

export const isTermuxSupported = termuxModule !== null;

export const termuxNative = {
    isInstalled: () => termuxModule?.isInstalled() ?? false,
    hasPermission: () => termuxModule?.hasPermission() ?? false,
    requestPermission: async () => (await termuxModule?.requestPermission())?.granted ?? false,
    run: termuxModule
        ? (argv: string[], cwd: string | undefined, timeoutMs: number) =>
              termuxModule.run(argv, cwd ?? null, timeoutMs)
        : null,
    isEnabled: async () => (await SecureStore.getItemAsync(TERMUX_ENABLED_KEY)) === 'true',
    setEnabled: (isEnabled: boolean) =>
        isEnabled
            ? SecureStore.setItemAsync(TERMUX_ENABLED_KEY, 'true')
            : SecureStore.deleteItemAsync(TERMUX_ENABLED_KEY),
};
