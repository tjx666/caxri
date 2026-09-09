import type { CSSProperties } from 'react';

import caxriLogoUrl from '../../assets/caxri-logo.png';
import { SessionHistoryNavigation } from './session-history-navigation';

/**
 * Vite serves this repo-only asset in development without bundling it into production.
 */
const primarySidebarLogoUrl = import.meta.env.DEV ? '/src/assets/caxri-logo-dev.png' : caxriLogoUrl;

export function PrimarySidebarHeader({ isFullScreen }: { isFullScreen: boolean }) {
    return (
        <div
            className={`primary-sidebar-title flex h-11 items-center py-0 pr-2 font-semibold ${isFullScreen ? 'pl-3' : 'pl-[84px]'}`}
            style={{ WebkitAppRegion: 'drag' } as CSSProperties}
        >
            {isFullScreen && (
                /**
                 * Fullscreen hides the traffic lights; the logo anchors the header in their absence.
                 */
                <img
                    src={primarySidebarLogoUrl}
                    alt="Caxri"
                    className="mr-2 h-7 w-7 object-contain"
                    data-caxri-logo
                />
            )}
            <SessionHistoryNavigation />
        </div>
    );
}
