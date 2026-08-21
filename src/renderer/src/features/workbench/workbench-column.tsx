import { useEffect } from 'react';

import { cn } from '../../lib/utilities';
import {
    BOTTOM_PANEL_DEFAULT_HEIGHT,
    BOTTOM_PANEL_MAX_HEIGHT,
    BOTTOM_PANEL_MIN_HEIGHT,
    usePanelLayoutStore,
} from '../../stores/panel-layout';
import { BottomPanel } from '../bottom-panel/bottom-panel';
import { PanelDivider } from './panel-divider';
import { Workbench } from './workbench';

/**
 * The centre column of the app shell: the work surface with the Bottom Panel docked beneath it.
 *
 * The Bottom Panel lives inside this column rather than spanning the full window, so the Sidebar and Inspector keep
 * their full height — the same arrangement VS Code ships, and the one that protects the Inspector's file and source
 * control trees from losing vertical room to a log stream.
 */
export function WorkbenchColumn() {
    const isBottomPanelVisible = usePanelLayoutStore((state) => state.bottomPanelVisible);
    const bottomPanelHeight = usePanelLayoutStore((state) => state.bottomPanelHeight);
    /**
     * Only the committed height reaches the DOM through React; a drag in progress writes the same custom property
     * directly (see `PanelDivider`), so this effect never fires mid-gesture. Mirrors the Sidebar/Inspector widths in
     * `app.tsx`, and writes to the root element because that is where the divider's drag writes too.
     */
    useEffect(() => {
        document.documentElement.style.setProperty(
            '--bottom-panel-height',
            `${bottomPanelHeight}px`,
        );
    }, [bottomPanelHeight]);

    return (
        <div
            className={cn(
                'workbench-column grid min-h-0 min-w-0',
                isBottomPanelVisible
                    ? 'grid-rows-[minmax(0,1fr)_6px_var(--bottom-panel-height,220px)]'
                    : 'grid-rows-[minmax(0,1fr)]',
            )}
        >
            <Workbench />
            {isBottomPanelVisible && (
                <PanelDivider
                    ariaLabel="Resize Bottom Panel"
                    size={bottomPanelHeight}
                    min={BOTTOM_PANEL_MIN_HEIGHT}
                    max={BOTTOM_PANEL_MAX_HEIGHT}
                    defaultSize={BOTTOM_PANEL_DEFAULT_HEIGHT}
                    cssVariable="--bottom-panel-height"
                    growDirection={-1}
                    orientation="horizontal"
                    onCommit={(height) =>
                        usePanelLayoutStore.getState().setBottomPanelHeight(height)
                    }
                />
            )}
            {isBottomPanelVisible && <BottomPanel />}
        </div>
    );
}
