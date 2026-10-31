import { useCallback, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import type { MobileUpdateBundle } from '@caxri/protocol';
import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';

import { useTranslation } from '../../i18n';
import { useMobileClient } from '../connection/mobile-client-provider';
import { MobileUpdateRecoveryRejectedError } from '../connection/recover-mobile-update';
import { downloadMobileUpdate, launchMobileUpdateInstaller } from './mobile-update-native';
import type { MobileUpdateCheckStatus, MobileUpdatePhase } from './mobile-update-state';
import {
    installMobileUpdate,
    mobileUpdateCheckStatus,
    mobileUpdateStore,
    newerMobileUpdate,
    preparedMobileUpdateFromRecovery,
} from './mobile-update-state';

export interface MobileUpdate {
    /**
     * Update recovery failed for a reason asking again can fix, such as a timeout. A rejected pairing is not one.
     */
    canRetryCheck: boolean;
    /**
     * Asks Desktop for its build again: Retry on the recovery banner, and a tap on the Settings version row.
     */
    checkNow: () => void;
    checkStatus: MobileUpdateCheckStatus;
    dismiss: () => void;
    install: () => void;
    /**
     * Update recovery is still asking the newer Desktop for its build.
     */
    isChecking: boolean;
    isDismissed: boolean;
    /**
     * A newer Desktop refuses this app's transport version, so its bundled build is the only way to reconnect.
     */
    isRecovering: boolean;
    phase: MobileUpdatePhase;
    update: MobileUpdateBundle | undefined;
}

/**
 * The paired Desktop's bundled Android build, when it is newer than this app. While connected it comes from
 * `mobile.update.check`; while a newer Desktop refuses this app's transport it comes from update recovery. iOS never
 * asks because Desktop ships no iOS build. A development client never asks either: it is debug-signed, so Android would
 * reject the release APK as a conflicting package.
 */
export const useMobileUpdate = (): MobileUpdate => {
    const { connectionScopeKey, isForeground, recoverUpdate, request, status } = useMobileClient();
    const { t } = useTranslation();
    const canUpdate = Platform.OS === 'android' && !__DEV__;
    const isRecovering = canUpdate && recoverUpdate !== null;
    const check = useQuery({
        enabled:
            canUpdate &&
            connectionScopeKey !== null &&
            isForeground &&
            (status === 'connected' || isRecovering),
        networkMode: 'always',
        queryFn: async () =>
            recoverUpdate
                ? { bundle: (await recoverUpdate()).bundle }
                : request('mobile.update.check'),
        queryKey: [
            'mobile',
            'update',
            connectionScopeKey ?? 'unpaired',
            isRecovering ? 'recovery' : 'connected',
        ],
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 10 * 60_000,
    });
    const snapshot = useSyncExternalStore(
        mobileUpdateStore.subscribe,
        mobileUpdateStore.get,
        mobileUpdateStore.get,
    );
    const update = newerMobileUpdate(
        Constants.expoConfig?.android?.versionCode,
        check.data?.bundle,
    );
    const checkStatus = mobileUpdateCheckStatus({
        canUpdate,
        hasAnswer: check.data !== undefined,
        isError: check.isError,
        isFetching: check.isFetching,
        update,
    });
    const install = useCallback(() => {
        const current = mobileUpdateStore.get().phase.kind;
        if (current === 'downloading' || current === 'installing') return;
        void installMobileUpdate(
            {
                download: downloadMobileUpdate,
                launchInstaller: launchMobileUpdateInstaller,
                // Recovery issues a fresh URL per exchange, so a URL from the earlier check never has to outlive its TTL.
                prepare: async () =>
                    recoverUpdate
                        ? preparedMobileUpdateFromRecovery(await recoverUpdate())
                        : request('mobile.update.prepare'),
            },
            mobileUpdateStore.setPhase,
            t,
        );
    }, [recoverUpdate, request, t]);
    const { refetch } = check;
    const checkNow = useCallback(() => {
        void refetch();
    }, [refetch]);
    const versionCode = update?.versionCode;
    const dismiss = useCallback(() => {
        if (versionCode !== undefined) mobileUpdateStore.dismiss(versionCode);
    }, [versionCode]);
    return {
        canRetryCheck:
            isRecovering &&
            check.isError &&
            !(check.error instanceof MobileUpdateRecoveryRejectedError),
        checkNow,
        checkStatus,
        dismiss,
        install,
        isChecking: isRecovering && check.isFetching,
        isDismissed: versionCode !== undefined && snapshot.dismissedVersionCode === versionCode,
        isRecovering,
        phase: snapshot.phase,
        update,
    };
};
