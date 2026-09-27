import { useEffect } from 'react';

/**
 * Removes the pre-bundle `#startup-loader` from `index.html` once the workbench has attached; its opaque shell now
 * covers the window.
 */
export function useStartupLoaderRemoval(isAttached: boolean): void {
    useEffect(() => {
        if (isAttached) document.querySelector('#startup-loader')?.remove();
    }, [isAttached]);
}
