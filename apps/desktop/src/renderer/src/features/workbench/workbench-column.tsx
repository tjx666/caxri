import { useEffect } from 'react';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import {
    PANEL_DEFAULT_HEIGHT,
    PANEL_MAX_HEIGHT,
    PANEL_MIN_HEIGHT,
    useChromeLayoutStore,
} from '../../stores/chrome-layout';
import { Panel } from '../panel/panel';
import { SessionTabStrip } from '../session-tabs/session-tab-strip';
import { PanelDivider } from './panel-divider';
import { Workbench } from './workbench';

/**
 * The centre column of the app shell: the work surface with the Panel docked beneath it.
 *
 * The Panel lives inside this column rather than spanning the full window, so the PrimarySidebar and SecondarySidebar
 * keep their full height: the same arrangement VS Code ships, and the one that protects the SecondarySidebar's file and
 * source control trees from losing vertical room to a log stream.
 *
 * The Open Session strip is the first row, above the Workbench and the Panel, so it spans the column the way a title
 * bar does and the Panel's resize math (which only sees the grid below it) is untouched.
 */
export function WorkbenchColumn() {
    const { t } = useTranslation();
    const isPanelVisible = useChromeLayoutStore((state) => state.panelVisible);
    const panelHeight = useChromeLayoutStore((state) => state.panelHeight);
    /**
     * Only the committed height reaches the DOM through React; a drag in progress writes the same custom property
     * directly (see `PanelDivider`), so this effect never fires mid-gesture. Mirrors the
     * PrimarySidebar/SecondarySidebar widths in `app.tsx`, and writes to the root element because that is where the
     * divider's drag writes too.
     */
    useEffect(() => {
        document.documentElement.style.setProperty('--panel-height', `${panelHeight}px`);
    }, [panelHeight]);

    return (
        <div className="workbench-column flex min-h-0 min-w-0 flex-col">
            <SessionTabStrip />
            <div
                className={cn(
                    'grid min-h-0 min-w-0 flex-1',
                    isPanelVisible
                        ? 'grid-rows-[minmax(0,1fr)_6px_var(--panel-height,220px)]'
                        : 'grid-rows-[minmax(0,1fr)]',
                )}
            >
                <Workbench />
                {isPanelVisible && (
                    <PanelDivider
                        ariaLabel={t('workbench.resizePanel')}
                        size={panelHeight}
                        min={PANEL_MIN_HEIGHT}
                        max={PANEL_MAX_HEIGHT}
                        defaultSize={PANEL_DEFAULT_HEIGHT}
                        cssVariable="--panel-height"
                        growDirection={-1}
                        orientation="horizontal"
                        onCommit={(height) =>
                            useChromeLayoutStore.getState().setPanelHeight(height)
                        }
                    />
                )}
                {isPanelVisible && <Panel />}
            </div>
        </div>
    );
}
