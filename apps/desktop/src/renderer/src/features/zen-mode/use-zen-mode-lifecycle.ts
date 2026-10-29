import { useEffect } from 'react';

import { defaultAppSettings } from '@caxri/protocol';

import { useWorkbenchStore } from '../../stores/workbench';
import { startZenModeLifecycle } from './zen-mode-lifecycle';

/**
 * Starts the Zen Mode window lifecycle once the Settings are known, so `zen.restore` is read from the user's value
 * rather than the default. The Settings are read at each Zen transition, so a change applies without a restart.
 */
export function useZenModeLifecycle(): void {
    const isReady = useWorkbenchStore((state) => state.bootstrap !== undefined);
    useEffect(() => {
        if (!isReady) return;
        const settings = () => useWorkbenchStore.getState().bootstrap?.settings;
        return startZenModeLifecycle({
            isFullScreenEnabled: () =>
                settings()?.['zen.fullScreen'] ?? defaultAppSettings['zen.fullScreen'],
            isRestoreEnabled: () =>
                settings()?.['zen.restore'] ?? defaultAppSettings['zen.restore'],
        });
    }, [isReady]);
}
