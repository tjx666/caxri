import { useEffect } from 'react';

/**
 * Removes the pre-bundle `#startup-loader` from `index.html` once the workbench has attached; its opaque shell now
 * covers the window. The removal is also the Workbench's first visible frame, so it closes Main's startup profile.
 */
export function useStartupLoaderRemoval(isAttached: boolean): void {
    useEffect(() => {
        if (!isAttached) return;
        const loader = document.querySelector('#startup-loader');
        if (!loader) return;
        loader.remove();
        const loaderRemovedMs = performance.now();
        // Two frames: the first commits the removal, the second runs after it was presented.
        requestAnimationFrame(() =>
            requestAnimationFrame(() =>
                globalThis.caxri.reportDiagnostic({
                    kind: 'startup-frame',
                    diagnosticId: crypto.randomUUID(),
                    timeOriginEpochMs: performance.timeOrigin,
                    loaderRemovedMs,
                    firstFrameMs: performance.now(),
                    documentVisible: document.visibilityState === 'visible',
                }),
            ),
        );
    }, [isAttached]);
}
