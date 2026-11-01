import { useCallback, useEffect, useState } from 'react';

import { useMobileClient } from '../connection/mobile-client-provider';
import { isTermuxSupported, termuxNative } from './termux-native';
import type { TermuxSettingState } from './termux-setting-model';
import { termuxSettingState } from './termux-setting-model';

const readTermuxSetting = async (): Promise<TermuxSettingState> =>
    termuxSettingState({
        isSupported: isTermuxSupported,
        isInstalled: termuxNative.isInstalled(),
        isEnabled: await termuxNative.isEnabled(),
        hasPermission: termuxNative.hasPermission(),
    });

/**
 * Reads the setting when Settings opens and whenever Caxri returns to the foreground, since Termux can be installed or
 * the permission revoked meanwhile. Turning it on asks Android for Termux's `RUN_COMMAND` permission first.
 */
export const useTermuxSetting = () => {
    const { isForeground } = useMobileClient();
    // The stored choice is read asynchronously; until then the synchronous facts give a near-final first paint.
    const [state, setState] = useState<TermuxSettingState>(() =>
        termuxSettingState({
            isSupported: isTermuxSupported,
            isInstalled: termuxNative.isInstalled(),
            isEnabled: false,
            hasPermission: false,
        }),
    );
    const [isDenied, setIsDenied] = useState(false);
    useEffect(() => {
        if (!isForeground || !isTermuxSupported) return;
        let isCurrent = true;
        void readTermuxSetting().then((next) => {
            if (isCurrent) setState(next);
        });
        return () => {
            isCurrent = false;
        };
    }, [isForeground]);
    const toggle = useCallback(() => {
        const apply = async () => {
            if (state === 'on') {
                await termuxNative.setEnabled(false);
            } else if (state === 'off') {
                const isGranted =
                    termuxNative.hasPermission() || (await termuxNative.requestPermission());
                setIsDenied(!isGranted);
                if (isGranted) await termuxNative.setEnabled(true);
            }
            setState(await readTermuxSetting());
        };
        void apply();
    }, [state]);
    return { isDenied, state, toggle };
};
