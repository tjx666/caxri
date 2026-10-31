import { requireOptionalNativeModule } from 'expo';
import * as SecureStore from 'expo-secure-store';

import type { NativeProcessExit, PreviousExitPorts } from './previous-exit';

interface CaxriExitReasonModule {
    readPreviousExit(): Promise<NativeProcessExit | null>;
}

/**
 * The local module in `modules/caxri-exit-reason`. It is absent on iOS and in a build without it, where there is
 * nothing to read; it reads nothing before Android 11 either.
 */
const exitReasonModule = requireOptionalNativeModule<CaxriExitReasonModule>('CaxriExitReason');

const REPORTED_EXIT_KEY = 'caxri.mobile-reported-exit.v1';

export const nativePreviousExitPorts: Omit<PreviousExitPorts, 'report'> = {
    readExit: () => exitReasonModule?.readPreviousExit() ?? Promise.resolve(null),
    loadReportedAt: async () => Number(await SecureStore.getItemAsync(REPORTED_EXIT_KEY)) || 0,
    saveReportedAt: (exitedAt) => SecureStore.setItemAsync(REPORTED_EXIT_KEY, String(exitedAt)),
};
