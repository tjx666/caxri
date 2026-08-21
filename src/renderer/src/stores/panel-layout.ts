import { useEffect } from 'react';

import type { BottomPanelView } from '@shared/bottom-panel';
import { isBottomPanelView } from '@shared/bottom-panel';
import { clamp } from 'es-toolkit';
import { create } from 'zustand';

/**
 * Renderer-local chrome layout: Sidebar/Inspector widths, Bottom Panel height, their visibility, and the Bottom Panel's
 * active view. Unlike Session state (`workbench.ts`), this is device-specific presentation, never written through to
 * the Runtime, so it persists to `localStorage` instead.
 */

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
/**
 * Matches the width `.app-shell` already shipped with in `styles.css` before this feature.
 */
export const SIDEBAR_DEFAULT_WIDTH = 230;

export const INSPECTOR_MIN_WIDTH = 240;
export const INSPECTOR_MAX_WIDTH = 600;
/**
 * Matches the width `.app-shell` already shipped with in `styles.css` before this feature.
 */
export const INSPECTOR_DEFAULT_WIDTH = 310;

export const BOTTOM_PANEL_MIN_HEIGHT = 120;
export const BOTTOM_PANEL_MAX_HEIGHT = 900;
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 220;

/**
 * Width of each visible Sidebar/Inspector resize track in `app.tsx`, and the height of the Bottom Panel's horizontal
 * track in `workbench-column.tsx`. Both seams share one thickness so the chrome reads as a single system.
 */
export const PANEL_DIVIDER_WIDTH = 6;

/**
 * The main pane must keep at least this much room; see `clampLayoutToViewport`.
 */
export const MIN_MAIN_WIDTH = 320;

/**
 * The work surface above the Bottom Panel must keep at least this much room. Measured against the full viewport height
 * rather than the Workbench column's own box: the column's height is not known until layout runs, and the chrome above
 * it (tab strip) and below it (24px Status Bar) is a fixed, small budget the reserve already absorbs.
 */
export const MIN_WORK_SURFACE_HEIGHT = 180;

/**
 * Arrow-key resize step in pixels, per the divider's keyboard interaction contract.
 */
export const PANEL_RESIZE_STEP = 16;

const STORAGE_KEY = 'caxri.panel-layout';

export interface PanelLayout {
    sidebarWidth: number;
    inspectorWidth: number;
    bottomPanelHeight: number;
    sidebarVisible: boolean;
    inspectorVisible: boolean;
    bottomPanelVisible: boolean;
    bottomPanelView: BottomPanelView;
}

const DEFAULT_PANEL_LAYOUT: PanelLayout = {
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
    bottomPanelHeight: BOTTOM_PANEL_DEFAULT_HEIGHT,
    sidebarVisible: true,
    inspectorVisible: true,
    /**
     * Closed at rest, like VS Code's Panel: the Terminal is the hero (DESIGN.md), and Logs/Info are consulted on demand
     * rather than watched continuously. Keeping it closed also leaves the Logs poll unmounted until asked for.
     */
    bottomPanelVisible: false,
    bottomPanelView: 'logs',
};

export function clampWidth(width: number, min: number, max: number): number {
    if (!Number.isFinite(width)) return min;
    return clamp(width, min, max);
}

/**
 * Re-clamps both panels against the current viewport so neither can crowd the main pane below {@link MIN_MAIN_WIDTH}.
 * Shrinks the Inspector first, then the Sidebar, never below either panel's own minimum — called on window resize and
 * whenever a persisted layout is restored.
 */
export function clampLayoutToViewport(layout: PanelLayout, viewportWidth: number): PanelLayout {
    let sidebarWidth = clampWidth(layout.sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
    let inspectorWidth = clampWidth(
        layout.inspectorWidth,
        INSPECTOR_MIN_WIDTH,
        INSPECTOR_MAX_WIDTH,
    );
    const reservedSidebar = layout.sidebarVisible ? sidebarWidth : 0;
    const reservedInspector = layout.inspectorVisible ? inspectorWidth : 0;
    const dividerWidth =
        Number(layout.sidebarVisible) * PANEL_DIVIDER_WIDTH +
        Number(layout.inspectorVisible) * PANEL_DIVIDER_WIDTH;
    let overflow =
        reservedSidebar + reservedInspector + dividerWidth + MIN_MAIN_WIDTH - viewportWidth;
    if (overflow > 0 && layout.inspectorVisible) {
        const shrink = Math.min(overflow, inspectorWidth - INSPECTOR_MIN_WIDTH);
        inspectorWidth -= shrink;
        overflow -= shrink;
    }
    if (overflow > 0 && layout.sidebarVisible) {
        const shrink = Math.min(overflow, sidebarWidth - SIDEBAR_MIN_WIDTH);
        sidebarWidth -= shrink;
    }
    return { ...layout, sidebarWidth, inspectorWidth };
}

/**
 * Re-clamps the Bottom Panel so it can never crowd the work surface below {@link MIN_WORK_SURFACE_HEIGHT}. Kept separate
 * from {@link clampLayoutToViewport} because the two axes are independent: the horizontal pass has to choose a shrink
 * order between two panels, while the vertical pass constrains a single one.
 */
export function clampBottomPanelHeight(height: number, viewportHeight: number): number {
    const bounded = clampWidth(height, BOTTOM_PANEL_MIN_HEIGHT, BOTTOM_PANEL_MAX_HEIGHT);
    if (!Number.isFinite(viewportHeight)) return bounded;
    const available = viewportHeight - MIN_WORK_SURFACE_HEIGHT - PANEL_DIVIDER_WIDTH;
    // A viewport too short for both keeps the panel at its own minimum rather than collapsing it to nothing;
    // the work surface yields instead, matching how the horizontal pass never shrinks a panel past its minimum.
    return Math.max(Math.min(bounded, available), BOTTOM_PANEL_MIN_HEIGHT);
}

function isBrowser(): boolean {
    // DOM lib types declare `localStorage` as always present, but this module also runs under Vitest's Node
    // environment, where the global is genuinely absent.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
    return typeof window !== 'undefined' && globalThis.localStorage !== undefined;
}

/**
 * Falls back to defaults for a missing/corrupt entry instead of throwing during module load.
 */
function readPersistedLayout(): PanelLayout {
    if (!isBrowser()) return DEFAULT_PANEL_LAYOUT;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_PANEL_LAYOUT;
        const parsed = JSON.parse(raw) as Partial<PanelLayout>;
        return {
            sidebarWidth: clampWidth(
                typeof parsed.sidebarWidth === 'number'
                    ? parsed.sidebarWidth
                    : SIDEBAR_DEFAULT_WIDTH,
                SIDEBAR_MIN_WIDTH,
                SIDEBAR_MAX_WIDTH,
            ),
            inspectorWidth: clampWidth(
                typeof parsed.inspectorWidth === 'number'
                    ? parsed.inspectorWidth
                    : INSPECTOR_DEFAULT_WIDTH,
                INSPECTOR_MIN_WIDTH,
                INSPECTOR_MAX_WIDTH,
            ),
            bottomPanelHeight: clampWidth(
                typeof parsed.bottomPanelHeight === 'number'
                    ? parsed.bottomPanelHeight
                    : BOTTOM_PANEL_DEFAULT_HEIGHT,
                BOTTOM_PANEL_MIN_HEIGHT,
                BOTTOM_PANEL_MAX_HEIGHT,
            ),
            sidebarVisible:
                typeof parsed.sidebarVisible === 'boolean' ? parsed.sidebarVisible : true,
            inspectorVisible:
                typeof parsed.inspectorVisible === 'boolean' ? parsed.inspectorVisible : true,
            bottomPanelVisible:
                typeof parsed.bottomPanelVisible === 'boolean' ? parsed.bottomPanelVisible : false,
            bottomPanelView: isBottomPanelView(parsed.bottomPanelView)
                ? parsed.bottomPanelView
                : DEFAULT_PANEL_LAYOUT.bottomPanelView,
        };
    } catch {
        return DEFAULT_PANEL_LAYOUT;
    }
}

function writePersistedLayout(layout: PanelLayout): void {
    if (!isBrowser()) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
        // Storage full or disabled (private mode); the layout still works for this session.
    }
}

/**
 * Revalidates a visibility change immediately instead of waiting for the next window resize.
 */
function fitCurrentViewport(layout: PanelLayout): PanelLayout {
    if (!isBrowser()) return layout;
    return {
        ...clampLayoutToViewport(layout, window.innerWidth),
        bottomPanelHeight: clampBottomPanelHeight(layout.bottomPanelHeight, window.innerHeight),
    };
}

interface PanelLayoutState extends PanelLayout {
    setSidebarWidth(width: number): void;
    setInspectorWidth(width: number): void;
    setBottomPanelHeight(height: number): void;
    resetSidebarWidth(): void;
    resetInspectorWidth(): void;
    resetBottomPanelHeight(): void;
    toggleSidebar(): void;
    toggleInspector(): void;
    toggleBottomPanel(): void;
    setSidebarVisible(isVisible: boolean): void;
    setInspectorVisible(isVisible: boolean): void;
    setBottomPanelVisible(isVisible: boolean): void;
    /**
     * Selects a Bottom Panel view, revealing the panel when it is collapsed so a command can never select a view the
     * user cannot see. Mirrors `activateInspectorMode` in `commands/execute.ts`.
     */
    activateBottomPanelView(view: BottomPanelView): void;
    /**
     * Re-clamps the persisted layout against a new viewport; see {@link clampLayoutToViewport} and
     * {@link clampBottomPanelHeight}.
     */
    clampToViewport(viewportWidth: number, viewportHeight: number): void;
}

function pickLayout(state: PanelLayout): PanelLayout {
    return {
        sidebarWidth: state.sidebarWidth,
        inspectorWidth: state.inspectorWidth,
        bottomPanelHeight: state.bottomPanelHeight,
        sidebarVisible: state.sidebarVisible,
        inspectorVisible: state.inspectorVisible,
        bottomPanelVisible: state.bottomPanelVisible,
        bottomPanelView: state.bottomPanelView,
    };
}

export const usePanelLayoutStore = create<PanelLayoutState>((set, get) => ({
    ...readPersistedLayout(),
    setSidebarWidth(width) {
        const sidebarWidth = clampWidth(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
        writePersistedLayout({ ...pickLayout(get()), sidebarWidth });
        set({ sidebarWidth });
    },
    setInspectorWidth(width) {
        const inspectorWidth = clampWidth(width, INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH);
        writePersistedLayout({ ...pickLayout(get()), inspectorWidth });
        set({ inspectorWidth });
    },
    setBottomPanelHeight(height) {
        const bottomPanelHeight = isBrowser()
            ? clampBottomPanelHeight(height, window.innerHeight)
            : clampWidth(height, BOTTOM_PANEL_MIN_HEIGHT, BOTTOM_PANEL_MAX_HEIGHT);
        writePersistedLayout({ ...pickLayout(get()), bottomPanelHeight });
        set({ bottomPanelHeight });
    },
    resetSidebarWidth() {
        writePersistedLayout({ ...pickLayout(get()), sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
        set({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
    },
    resetInspectorWidth() {
        writePersistedLayout({ ...pickLayout(get()), inspectorWidth: INSPECTOR_DEFAULT_WIDTH });
        set({ inspectorWidth: INSPECTOR_DEFAULT_WIDTH });
    },
    resetBottomPanelHeight() {
        const bottomPanelHeight = isBrowser()
            ? clampBottomPanelHeight(BOTTOM_PANEL_DEFAULT_HEIGHT, window.innerHeight)
            : BOTTOM_PANEL_DEFAULT_HEIGHT;
        writePersistedLayout({ ...pickLayout(get()), bottomPanelHeight });
        set({ bottomPanelHeight });
    },
    toggleSidebar() {
        const isSidebarVisible = !get().sidebarVisible;
        const layout = fitCurrentViewport({
            ...pickLayout(get()),
            sidebarVisible: isSidebarVisible,
        });
        writePersistedLayout(layout);
        set(layout);
    },
    toggleInspector() {
        const isInspectorVisible = !get().inspectorVisible;
        const layout = fitCurrentViewport({
            ...pickLayout(get()),
            inspectorVisible: isInspectorVisible,
        });
        writePersistedLayout(layout);
        set(layout);
    },
    setSidebarVisible(isVisible) {
        const layout = fitCurrentViewport({ ...pickLayout(get()), sidebarVisible: isVisible });
        writePersistedLayout(layout);
        set(layout);
    },
    setInspectorVisible(isVisible) {
        const layout = fitCurrentViewport({ ...pickLayout(get()), inspectorVisible: isVisible });
        writePersistedLayout(layout);
        set(layout);
    },
    toggleBottomPanel() {
        const layout = fitCurrentViewport({
            ...pickLayout(get()),
            bottomPanelVisible: !get().bottomPanelVisible,
        });
        writePersistedLayout(layout);
        set(layout);
    },
    setBottomPanelVisible(isVisible) {
        const layout = fitCurrentViewport({
            ...pickLayout(get()),
            bottomPanelVisible: isVisible,
        });
        writePersistedLayout(layout);
        set(layout);
    },
    activateBottomPanelView(view) {
        const layout = fitCurrentViewport({
            ...pickLayout(get()),
            bottomPanelVisible: true,
            bottomPanelView: view,
        });
        writePersistedLayout(layout);
        set(layout);
    },
    clampToViewport(viewportWidth, viewportHeight) {
        const current = pickLayout(get());
        const next = {
            ...clampLayoutToViewport(current, viewportWidth),
            bottomPanelHeight: clampBottomPanelHeight(current.bottomPanelHeight, viewportHeight),
        };
        if (
            next.sidebarWidth === current.sidebarWidth &&
            next.inspectorWidth === current.inspectorWidth &&
            next.bottomPanelHeight === current.bottomPanelHeight
        )
            return;
        writePersistedLayout(next);
        set(next);
    },
}));

/**
 * Keeps the persisted layout valid as the window resizes. Runs once on mount (a persisted layout from a larger window
 * could otherwise overflow a smaller one) and again on every `resize` event.
 */
export function usePanelViewportClamp(): void {
    useEffect(() => {
        const clamp = (): void =>
            usePanelLayoutStore.getState().clampToViewport(window.innerWidth, window.innerHeight);
        clamp();
        // ResizeObserver on the root element reacts to viewport width changes without a
        // window-level `resize` listener, satisfying unicorn/prefer-observer-apis.
        const observer = new ResizeObserver(clamp);
        observer.observe(document.documentElement);
        return () => observer.disconnect();
    }, []);
}
