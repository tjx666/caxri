import { useEffect } from 'react';

import { clamp } from 'es-toolkit';
import { create } from 'zustand';

/**
 * Renderer-local chrome layout: Sidebar/Inspector widths and visibility. Unlike Session state (`workbench.ts`), this is
 * device-specific presentation, never written through to the Runtime, so it persists to `localStorage` instead.
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

/**
 * Width of each visible Sidebar/Inspector resize track in `app.tsx`.
 */
export const PANEL_DIVIDER_WIDTH = 6;

/**
 * The main pane must keep at least this much room; see `clampLayoutToViewport`.
 */
export const MIN_MAIN_WIDTH = 320;

/**
 * Arrow-key resize step in pixels, per the divider's keyboard interaction contract.
 */
export const PANEL_RESIZE_STEP = 16;

const STORAGE_KEY = 'caxri.panel-layout';

export interface PanelLayout {
    sidebarWidth: number;
    inspectorWidth: number;
    sidebarVisible: boolean;
    inspectorVisible: boolean;
}

const DEFAULT_PANEL_LAYOUT: PanelLayout = {
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
    sidebarVisible: true,
    inspectorVisible: true,
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
    return {
        sidebarWidth,
        inspectorWidth,
        sidebarVisible: layout.sidebarVisible,
        inspectorVisible: layout.inspectorVisible,
    };
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
            sidebarVisible:
                typeof parsed.sidebarVisible === 'boolean' ? parsed.sidebarVisible : true,
            inspectorVisible:
                typeof parsed.inspectorVisible === 'boolean' ? parsed.inspectorVisible : true,
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
    return isBrowser() ? clampLayoutToViewport(layout, window.innerWidth) : layout;
}

interface PanelLayoutState extends PanelLayout {
    setSidebarWidth(width: number): void;
    setInspectorWidth(width: number): void;
    resetSidebarWidth(): void;
    resetInspectorWidth(): void;
    toggleSidebar(): void;
    toggleInspector(): void;
    setSidebarVisible(isVisible: boolean): void;
    setInspectorVisible(isVisible: boolean): void;
    /**
     * Re-clamps the persisted layout against a new viewport width; see {@link clampLayoutToViewport}.
     */
    clampToViewport(viewportWidth: number): void;
}

function pickLayout(state: PanelLayout): PanelLayout {
    return {
        sidebarWidth: state.sidebarWidth,
        inspectorWidth: state.inspectorWidth,
        sidebarVisible: state.sidebarVisible,
        inspectorVisible: state.inspectorVisible,
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
    resetSidebarWidth() {
        writePersistedLayout({ ...pickLayout(get()), sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
        set({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
    },
    resetInspectorWidth() {
        writePersistedLayout({ ...pickLayout(get()), inspectorWidth: INSPECTOR_DEFAULT_WIDTH });
        set({ inspectorWidth: INSPECTOR_DEFAULT_WIDTH });
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
    clampToViewport(viewportWidth) {
        const current = pickLayout(get());
        const next = clampLayoutToViewport(current, viewportWidth);
        if (
            next.sidebarWidth === current.sidebarWidth &&
            next.inspectorWidth === current.inspectorWidth
        )
            return;
        writePersistedLayout(next);
        set(next);
    },
}));

/**
 * Keeps the persisted layout valid as the window resizes. Runs once on mount (a persisted layout from a wider window
 * could otherwise overflow a narrower one) and again on every `resize` event.
 */
export function usePanelViewportClamp(): void {
    useEffect(() => {
        const clamp = (): void => usePanelLayoutStore.getState().clampToViewport(window.innerWidth);
        clamp();
        // ResizeObserver on the root element reacts to viewport width changes without a
        // window-level `resize` listener, satisfying unicorn/prefer-observer-apis.
        const observer = new ResizeObserver(clamp);
        observer.observe(document.documentElement);
        return () => observer.disconnect();
    }, []);
}
