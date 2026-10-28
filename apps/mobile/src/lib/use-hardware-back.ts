import { useEffect } from 'react';
import { BackHandler } from 'react-native';

/**
 * Registers an Android hardware Back handler while `onBack` is set. The handler returns `true` when it consumed the
 * press and `false` to let the next handler (ultimately the screen's own Back) run. Handlers run newest first, so a
 * sub-view that is open sees Back before the screen under it.
 */
export const useHardwareBack = (onBack: (() => boolean) | null): void => {
    useEffect(() => {
        if (!onBack) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', onBack);
        return () => subscription.remove();
    }, [onBack]);
};
