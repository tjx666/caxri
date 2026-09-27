import { useCallback, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import type { MobileUpdateBundle } from '@caxri/protocol';
import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';

import { useMobileClient } from '../connection/mobile-client-provider';
import { downloadMobileUpdate, launchMobileUpdateInstaller } from './mobile-update-native';
import type { MobileUpdatePhase } from './mobile-update-state';
import { installMobileUpdate, mobileUpdateStore, newerMobileUpdate } from './mobile-update-state';

export interface MobileUpdate {
    dismiss: () => void;
    install: () => void;
    isDismissed: boolean;
    phase: MobileUpdatePhase;
    update: MobileUpdateBundle | undefined;
}

/**
 * The paired Desktop's bundled Android build, when it is newer than this app. iOS never asks because Desktop ships no
 * iOS build. A development client never asks either: it is debug-signed, so Android would reject the release APK as a
 * conflicting package.
 */
export const useMobileUpdate = (): MobileUpdate => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const check = useQuery({
        enabled:
            Platform.OS === 'android' &&
            !__DEV__ &&
            connectionScopeKey !== null &&
            isForeground &&
            status === 'connected',
        networkMode: 'always',
        queryFn: () => request('mobile.update.check'),
        queryKey: ['mobile', 'update', connectionScopeKey ?? 'unpaired'],
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
    const install = useCallback(() => {
        const current = mobileUpdateStore.get().phase.kind;
        if (current === 'downloading' || current === 'installing') return;
        // eslint-disable-next-line no-void -- The workflow reports every outcome through the shared phase store.
        void installMobileUpdate(
            {
                download: downloadMobileUpdate,
                launchInstaller: launchMobileUpdateInstaller,
                prepare: () => request('mobile.update.prepare'),
            },
            mobileUpdateStore.setPhase,
        );
    }, [request]);
    const versionCode = update?.versionCode;
    const dismiss = useCallback(() => {
        if (versionCode !== undefined) mobileUpdateStore.dismiss(versionCode);
    }, [versionCode]);
    return {
        dismiss,
        install,
        isDismissed: versionCode !== undefined && snapshot.dismissedVersionCode === versionCode,
        phase: snapshot.phase,
        update,
    };
};
