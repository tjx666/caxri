import { useEffect } from 'react';

import type { ViewContainerId } from '@caxri/protocol';
import { viewContainerIdSchema } from '@caxri/protocol';
import { clamp } from 'es-toolkit';

import { readLocalStorageJson, writeLocalStorageJson } from '../lib/local-storage';
import { createStore } from '../lib/store';

/**
 * Renderer-local chrome layout: PrimarySidebar/SecondarySidebar widths, Panel height, their visibility, and the Panel's
 * active view. Unlike Session state (`workbench.ts`), this is device-specific presentation, never written through to
 * the Server, so it persists to `localStorage` instead.
 */

export const PRIMARY_SIDEBAR_MIN_WIDTH = 180;
export const PRIMARY_SIDEBAR_MAX_WIDTH = 480;
/**
 * Matches the width `.app-shell` already shipped with in `styles.css` before this feature.
 */
export const PRIMARY_SIDEBAR_DEFAULT_WIDTH = 230;

export const SECONDARY_SIDEBAR_MIN_WIDTH = 240;
export const SECONDARY_SIDEBAR_MAX_WIDTH = 600;
/**
 * Matches the width `.app-shell` already shipped with in `styles.css` before this feature.
 */
export const SECONDARY_SIDEBAR_DEFAULT_WIDTH = 310;

export const PANEL_MIN_HEIGHT = 120;
export const PANEL_MAX_HEIGHT = 900;
export const PANEL_DEFAULT_HEIGHT = 220;

/**
 * Width of each visible PrimarySidebar/SecondarySidebar resize track in `app.tsx`, and the height of the Panel's
 * horizontal track in `workbench-column.tsx`. Both seams share one thickness so the chrome reads as a single system.
 */
export const PANEL_DIVIDER_WIDTH = 6;

/**
 * The main pane must keep at least this much room; see `clampLayoutToViewport`.
 */
export const MIN_MAIN_WIDTH = 320;

/**
 * The work surface above the Panel must keep at least this much room. Measured against the full viewport height rather
 * than the Workbench column's own box: the column's height is not known until layout runs, and the chrome above it (tab
 * strip) and below it (24px Status Bar) is a fixed, small budget the reserve already absorbs.
 */
export const MIN_WORK_SURFACE_HEIGHT = 180;

/**
 * Arrow-key resize step in pixels, per the divider's keyboard interaction contract.
 */
export const PANEL_RESIZE_STEP = 16;

const STORAGE_KEY = 'caxri.chrome-layout';

export interface ChromeLayout {
    primarySidebarWidth: number;
    secondarySidebarWidth: number;
    panelHeight: number;
    primarySidebarVisible: boolean;
    secondarySidebarVisible: boolean;
    panelVisible: boolean;
    desiredPanelViewContainerId: ViewContainerId;
}

const DEFAULT_CHROME_LAYOUT: ChromeLayout = {
    primarySidebarWidth: PRIMARY_SIDEBAR_DEFAULT_WIDTH,
    secondarySidebarWidth: SECONDARY_SIDEBAR_DEFAULT_WIDTH,
    panelHeight: PANEL_DEFAULT_HEIGHT,
    primarySidebarVisible: true,
    secondarySidebarVisible: true,
    /**
     * Closed at rest, like VS Code's Panel: the Terminal is the hero (DESIGN.md), and Logs/Info are consulted on demand
     * rather than watched continuously. Keeping it closed also leaves the Logs poll unmounted until asked for.
     */
    panelVisible: false,
    desiredPanelViewContainerId: 'caxri.logs',
};

export function clampWidth(width: number, min: number, max: number): number {
    if (!Number.isFinite(width)) return min;
    return clamp(width, min, max);
}

/**
 * Re-clamps both panels against the current viewport so neither can crowd the main pane below {@link MIN_MAIN_WIDTH}.
 * Shrinks the SecondarySidebar first, then the PrimarySidebar, never below either panel's own minimum — called on
 * window resize and whenever a persisted layout is restored.
 */
export function clampLayoutToViewport(layout: ChromeLayout, viewportWidth: number): ChromeLayout {
    let primarySidebarWidth = clampWidth(
        layout.primarySidebarWidth,
        PRIMARY_SIDEBAR_MIN_WIDTH,
        PRIMARY_SIDEBAR_MAX_WIDTH,
    );
    let secondarySidebarWidth = clampWidth(
        layout.secondarySidebarWidth,
        SECONDARY_SIDEBAR_MIN_WIDTH,
        SECONDARY_SIDEBAR_MAX_WIDTH,
    );
    const reservedPrimarySidebar = layout.primarySidebarVisible ? primarySidebarWidth : 0;
    const reservedSecondarySidebar = layout.secondarySidebarVisible ? secondarySidebarWidth : 0;
    const dividerWidth =
        Number(layout.primarySidebarVisible) * PANEL_DIVIDER_WIDTH +
        Number(layout.secondarySidebarVisible) * PANEL_DIVIDER_WIDTH;
    let overflow =
        reservedPrimarySidebar +
        reservedSecondarySidebar +
        dividerWidth +
        MIN_MAIN_WIDTH -
        viewportWidth;
    if (overflow > 0 && layout.secondarySidebarVisible) {
        const shrink = Math.min(overflow, secondarySidebarWidth - SECONDARY_SIDEBAR_MIN_WIDTH);
        secondarySidebarWidth -= shrink;
        overflow -= shrink;
    }
    if (overflow > 0 && layout.primarySidebarVisible) {
        const shrink = Math.min(overflow, primarySidebarWidth - PRIMARY_SIDEBAR_MIN_WIDTH);
        primarySidebarWidth -= shrink;
    }
    return { ...layout, primarySidebarWidth, secondarySidebarWidth };
}

/**
 * Re-clamps the Panel so it can never crowd the work surface below {@link MIN_WORK_SURFACE_HEIGHT}. Kept separate from
 * {@link clampLayoutToViewport} because the two axes are independent: the horizontal pass has to choose a shrink order
 * between two panels, while the vertical pass constrains a single one.
 */
export function clampPanelHeight(height: number, viewportHeight: number): number {
    const bounded = clampWidth(height, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT);
    if (!Number.isFinite(viewportHeight)) return bounded;
    const available = viewportHeight - MIN_WORK_SURFACE_HEIGHT - PANEL_DIVIDER_WIDTH;
    // A viewport too short for both keeps the panel at its own minimum rather than collapsing it to nothing;
    // the work surface yields instead, matching how the horizontal pass never shrinks a panel past its minimum.
    return Math.max(Math.min(bounded, available), PANEL_MIN_HEIGHT);
}

function isBrowser(): boolean {
    // DOM lib types declare `window` as always present, but this module also runs under Vitest's Node environment,
    // where the global is genuinely absent.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
    return typeof window !== 'undefined';
}

/**
 * Falls back to defaults for a missing/corrupt entry instead of throwing during module load.
 */
function readPersistedLayout(): ChromeLayout {
    const parsed = readLocalStorageJson(STORAGE_KEY) as Partial<ChromeLayout> | undefined;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_CHROME_LAYOUT;
    return {
        primarySidebarWidth: clampWidth(
            typeof parsed.primarySidebarWidth === 'number'
                ? parsed.primarySidebarWidth
                : PRIMARY_SIDEBAR_DEFAULT_WIDTH,
            PRIMARY_SIDEBAR_MIN_WIDTH,
            PRIMARY_SIDEBAR_MAX_WIDTH,
        ),
        secondarySidebarWidth: clampWidth(
            typeof parsed.secondarySidebarWidth === 'number'
                ? parsed.secondarySidebarWidth
                : SECONDARY_SIDEBAR_DEFAULT_WIDTH,
            SECONDARY_SIDEBAR_MIN_WIDTH,
            SECONDARY_SIDEBAR_MAX_WIDTH,
        ),
        panelHeight: clampWidth(
            typeof parsed.panelHeight === 'number' ? parsed.panelHeight : PANEL_DEFAULT_HEIGHT,
            PANEL_MIN_HEIGHT,
            PANEL_MAX_HEIGHT,
        ),
        primarySidebarVisible:
            typeof parsed.primarySidebarVisible === 'boolean' ? parsed.primarySidebarVisible : true,
        secondarySidebarVisible:
            typeof parsed.secondarySidebarVisible === 'boolean'
                ? parsed.secondarySidebarVisible
                : true,
        panelVisible: typeof parsed.panelVisible === 'boolean' ? parsed.panelVisible : false,
        desiredPanelViewContainerId: viewContainerIdSchema.safeParse(
            parsed.desiredPanelViewContainerId,
        ).success
            ? (parsed.desiredPanelViewContainerId as ViewContainerId)
            : DEFAULT_CHROME_LAYOUT.desiredPanelViewContainerId,
    };
}

function writePersistedLayout(layout: ChromeLayout): void {
    writeLocalStorageJson(STORAGE_KEY, layout);
}

/**
 * Revalidates a visibility change immediately instead of waiting for the next window resize.
 */
function fitCurrentViewport(layout: ChromeLayout): ChromeLayout {
    if (!isBrowser()) return layout;
    return {
        ...clampLayoutToViewport(layout, window.innerWidth),
        panelHeight: clampPanelHeight(layout.panelHeight, window.innerHeight),
    };
}

interface ChromeLayoutState extends ChromeLayout {
    setPrimarySidebarWidth(width: number): void;
    setSecondarySidebarWidth(width: number): void;
    setPanelHeight(height: number): void;
    resetPrimarySidebarWidth(): void;
    resetSecondarySidebarWidth(): void;
    resetPanelHeight(): void;
    togglePrimarySidebar(): void;
    toggleSecondarySidebar(): void;
    togglePanel(): void;
    setPrimarySidebarVisible(isVisible: boolean): void;
    setSecondarySidebarVisible(isVisible: boolean): void;
    setPanelVisible(isVisible: boolean): void;
    /**
     * Selects a Panel view, revealing the panel when it is collapsed so a command can never select a view the user
     * cannot see. Mirrors `activateSecondarySidebarViewContainer` in `commands/execute.ts`.
     */
    activatePanelViewContainer(view: ViewContainerId): void;
    /**
     * Re-clamps the persisted layout against a new viewport; see {@link clampLayoutToViewport} and
     * {@link clampPanelHeight}.
     */
    clampToViewport(viewportWidth: number, viewportHeight: number): void;
}

function pickLayout(state: ChromeLayout): ChromeLayout {
    return {
        primarySidebarWidth: state.primarySidebarWidth,
        secondarySidebarWidth: state.secondarySidebarWidth,
        panelHeight: state.panelHeight,
        primarySidebarVisible: state.primarySidebarVisible,
        secondarySidebarVisible: state.secondarySidebarVisible,
        panelVisible: state.panelVisible,
        desiredPanelViewContainerId: state.desiredPanelViewContainerId,
    };
}

export const useChromeLayoutStore = createStore<ChromeLayoutState>('chrome-layout', (set, get) => ({
    ...readPersistedLayout(),
    setPrimarySidebarWidth(width) {
        const primarySidebarWidth = clampWidth(
            width,
            PRIMARY_SIDEBAR_MIN_WIDTH,
            PRIMARY_SIDEBAR_MAX_WIDTH,
        );
        writePersistedLayout({ ...pickLayout(get()), primarySidebarWidth });
        set({ primarySidebarWidth });
    },
    setSecondarySidebarWidth(width) {
        const secondarySidebarWidth = clampWidth(
            width,
            SECONDARY_SIDEBAR_MIN_WIDTH,
            SECONDARY_SIDEBAR_MAX_WIDTH,
        );
        writePersistedLayout({ ...pickLayout(get()), secondarySidebarWidth });
        set({ secondarySidebarWidth });
    },
    setPanelHeight(height) {
        const panelHeight = isBrowser()
            ? clampPanelHeight(height, window.innerHeight)
            : clampWidth(height, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT);
        writePersistedLayout({ ...pickLayout(get()), panelHeight });
        set({ panelHeight });
    },
    resetPrimarySidebarWidth() {
        writePersistedLayout({
            ...pickLayout(get()),
            primarySidebarWidth: PRIMARY_SIDEBAR_DEFAULT_WIDTH,
        });
        set({ primarySidebarWidth: PRIMARY_SIDEBAR_DEFAULT_WIDTH });
    },
    resetSecondarySidebarWidth() {
        writePersistedLayout({
            ...pickLayout(get()),
            secondarySidebarWidth: SECONDARY_SIDEBAR_DEFAULT_WIDTH,
        });
        set({ secondarySidebarWidth: SECONDARY_SIDEBAR_DEFAULT_WIDTH });
    },
    resetPanelHeight() {
        const panelHeight = isBrowser()
            ? clampPanelHeight(PANEL_DEFAULT_HEIGHT, window.innerHeight)
            : PANEL_DEFAULT_HEIGHT;
        writePersistedLayout({ ...pickLayout(get()), panelHeight });
        set({ panelHeight });
    },
    togglePrimarySidebar() {
        const isPrimarySidebarVisible = !get().primarySidebarVisible;
        const layout = fitCurrentViewport({
            ...pickLayout(get()),
            primarySidebarVisible: isPrimarySidebarVisible,
        });
        writePersistedLayout(layout);
        set(layout);
    },
    toggleSecondarySidebar() {
        const isSecondarySidebarVisible = !get().secondarySidebarVisible;
        const layout = fitCurrentViewport({
            ...pickLayout(get()),
            secondarySidebarVisible: isSecondarySidebarVisible,
        });
        writePersistedLayout(layout);
        set(layout);
    },
    setPrimarySidebarVisible(isVisible) {
        const layout = fitCurrentViewport({
            ...pickLayout(get()),
            primarySidebarVisible: isVisible,
        });
        writePersistedLayout(layout);
        set(layout);
    },
    setSecondarySidebarVisible(isVisible) {
        const layout = fitCurrentViewport({
            ...pickLayout(get()),
            secondarySidebarVisible: isVisible,
        });
        writePersistedLayout(layout);
        set(layout);
    },
    togglePanel() {
        const layout = fitCurrentViewport({
            ...pickLayout(get()),
            panelVisible: !get().panelVisible,
        });
        writePersistedLayout(layout);
        set(layout);
    },
    setPanelVisible(isVisible) {
        const layout = fitCurrentViewport({
            ...pickLayout(get()),
            panelVisible: isVisible,
        });
        writePersistedLayout(layout);
        set(layout);
    },
    activatePanelViewContainer(view) {
        const layout = fitCurrentViewport({
            ...pickLayout(get()),
            panelVisible: true,
            desiredPanelViewContainerId: view,
        });
        writePersistedLayout(layout);
        set(layout);
    },
    clampToViewport(viewportWidth, viewportHeight) {
        const current = pickLayout(get());
        const next = {
            ...clampLayoutToViewport(current, viewportWidth),
            panelHeight: clampPanelHeight(current.panelHeight, viewportHeight),
        };
        if (
            next.primarySidebarWidth === current.primarySidebarWidth &&
            next.secondarySidebarWidth === current.secondarySidebarWidth &&
            next.panelHeight === current.panelHeight
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
export function useChromeViewportClamp(): void {
    useEffect(() => {
        const clamp = (): void =>
            useChromeLayoutStore.getState().clampToViewport(window.innerWidth, window.innerHeight);
        clamp();
        // ResizeObserver on the root element reacts to viewport width changes without a
        // window-level `resize` listener, satisfying unicorn/prefer-observer-apis.
        const observer = new ResizeObserver(clamp);
        observer.observe(document.documentElement);
        return () => observer.disconnect();
    }, []);
}
