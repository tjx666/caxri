import { useEffect } from 'react';

import { useSettings } from '../../stores/selectors';

/**
 * Page zoom scales every CSS pixel but not the native traffic lights, so the header clearances reserved for them divide
 * by `--window-zoom-factor` to stay the lights' physical width. Main applies the zoom itself; this mirrors the same
 * setting with the same 20%-per-step formula (`zoomFactorForLevel` in `main/window-chrome.ts`). Every window that
 * follows the app zoom mounts it: the Workbench and the Agent Commander.
 */
export function useWindowZoomFactor(): void {
    const zoomLevel = useSettings()?.['window.zoomLevel'] ?? 0;
    useEffect(() => {
        document.documentElement.style.setProperty(
            '--window-zoom-factor',
            String(1.2 ** zoomLevel),
        );
    }, [zoomLevel]);
}
