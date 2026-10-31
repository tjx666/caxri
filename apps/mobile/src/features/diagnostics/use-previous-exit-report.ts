import { useEffect } from 'react';

import Constants from 'expo-constants';

import { useMobileClient } from '../connection/mobile-client-provider';
import { reportPreviousExit } from './previous-exit';
import { nativePreviousExitPorts } from './previous-exit-native';

/**
 * Settles once per app process: the previous exit cannot change while this process runs.
 */
const reportState = { isSettled: false };

/**
 * Tells the paired Desktop why the previous app process ended abnormally, once a connection is up. A failed report
 * stays pending and is retried on the next connection.
 */
export const usePreviousExitReport = (): void => {
    const { request, status } = useMobileClient();
    useEffect(() => {
        const appVersion = Constants.expoConfig?.version;
        const buildNumber = Constants.expoConfig?.android?.versionCode;
        if (status !== 'connected' || !appVersion || !buildNumber || reportState.isSettled) return;
        reportState.isSettled = true;
        const report = async () => {
            try {
                await reportPreviousExit(
                    {
                        ...nativePreviousExitPorts,
                        report: (parameters) =>
                            request('mobile.diagnostics.reportExit', parameters),
                    },
                    { appVersion, buildNumber },
                );
            } catch {
                reportState.isSettled = false;
            }
        };
        void report();
    }, [request, status]);
};
