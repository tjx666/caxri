import { useEffect, useEffectEvent } from 'react';
import { BackHandler } from 'react-native';

/**
 * Registers an Android hardware Back handler while `onBack` is set. The handler returns `true` when it consumed the
 * press and `false` to let the next handler (ultimately the screen's own Back) run. Handlers run newest first, so a
 * sub-view that is open sees Back before the screen under it. The subscription follows only whether a handler exists,
 * so a handler that changes on every render does not move this one behind a newer screen's.
 */
export const useHardwareBack = (onBack: (() => boolean) | null): void => {
    const isActive = onBack !== null;
    const handle = useEffectEvent(() => onBack?.() ?? false);
    useEffect(() => {
        if (!isActive) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', handle);
        return () => subscription.remove();
    }, [isActive]);
};
