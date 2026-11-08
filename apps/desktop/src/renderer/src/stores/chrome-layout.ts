import { useEffect } from 'react';

import type { ViewContainerId } from '@caxri/protocol';
import { viewContainerIdSchema } from '@caxri/protocol';
import { clamp } from 'es-toolkit';

import { createSharedLocalState } from '../lib/local-storage';
import { createStore } from '../lib/store';
import { handOffChromeFocus, refocusChromeSurfaceBody } from './chrome-focus-handoff';
import { useNotificationStore } from './notifications';

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

/**
 * The Portal (`features/agent-chat/portal/`) floats over the right edge of the window rather than taking a grid track,
 * so its width only bounds what it covers. 360px matches t3code's right panel minimum; the default leaves room for the
 * transcript's readable column inside a subagent timeline.
 */
export const PORTAL_MIN_WIDTH = 360;
export const PORTAL_MAX_WIDTH = 960;
export const PORTAL_DEFAULT_WIDTH = 480;

export const PANEL_MIN_HEIGHT = 120;
export const PANEL_MAX_HEIGHT = 900;
export const PANEL_DEFAULT_HEIGHT = 220;

/**
 * Height of the Panel's horizontal resize track in `workbench-column.tsx`. The PrimarySidebar/SecondarySidebar seams in
 * `app.tsx` take no width: their hit bands straddle a 0px track (see `PanelDivider`).
 */
export const PANEL_DIVIDER_HEIGHT = 6;

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
    portalWidth: number;
    panelHeight: number;
    primarySidebarVisible: boolean;
    secondarySidebarVisible: boolean;
    panelVisible: boolean;
    desiredPanelViewContainerId: ViewContainerId;
    /**
     * Swaps the Primary Side Bar's body between the Project tree and the Activity queue. Device-local like the rest of
     * this store rather than Session state: the queue spans every Project, so tying it to the selected Session would
     * make the side bar flip contents as the user walks it.
     */
    primarySidebarActivityMode: boolean;
}

const DEFAULT_CHROME_LAYOUT: ChromeLayout = {
    primarySidebarWidth: PRIMARY_SIDEBAR_DEFAULT_WIDTH,
    secondarySidebarWidth: SECONDARY_SIDEBAR_DEFAULT_WIDTH,
    portalWidth: PORTAL_DEFAULT_WIDTH,
    panelHeight: PANEL_DEFAULT_HEIGHT,
    primarySidebarVisible: true,
    secondarySidebarVisible: true,
    /**
     * Closed at rest, like VS Code's Panel: the Terminal is the hero (DESIGN.md), and Logs/Info are consulted on demand
     * rather than watched continuously. Keeping it closed also leaves the Logs poll unmounted until asked for.
     */
    panelVisible: false,
    desiredPanelViewContainerId: 'caxri.logs',
    primarySidebarActivityMode: false,
};

export function clampWidth(width: number, min: number, max: number): number {
    if (!Number.isFinite(width)) return min;
    return clamp(width, min, max);
}

/**
 * Re-clamps both panels against the current viewport so neither can crowd the main pane below {@link MIN_MAIN_WIDTH}.
 * Shrinks the SecondarySidebar first, then the PrimarySidebar, never below either panel's own minimum: called on window
 * resize and whenever a persisted layout is restored.
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
    let overflow =
        reservedPrimarySidebar + reservedSecondarySidebar + MIN_MAIN_WIDTH - viewportWidth;
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
    const available = viewportHeight - MIN_WORK_SURFACE_HEIGHT - PANEL_DIVIDER_HEIGHT;
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
function parsePersistedLayout(raw: unknown): ChromeLayout {
    const parsed = raw as Partial<ChromeLayout> | undefined;
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
        portalWidth: clampWidth(
            typeof parsed.portalWidth === 'number' ? parsed.portalWidth : PORTAL_DEFAULT_WIDTH,
            PORTAL_MIN_WIDTH,
            PORTAL_MAX_WIDTH,
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
        primarySidebarActivityMode:
            typeof parsed.primarySidebarActivityMode === 'boolean'
                ? parsed.primarySidebarActivityMode
                : false,
    };
}

/**
 * Per-window by design (docs/client-local-data.md): widths, visibility, and the Panel view belong to the window that
 * shows them, so a change in one window must not resize or hide another window's side bars, and this entry is never
 * subscribed to. It only seeds the layout of the next window that starts. Writes go field by field, so a window that
 * changes its Panel height does not revert the sidebar width another window saved meanwhile; for the same field the
 * last window to change it wins.
 */
const sharedLayout = createSharedLocalState(STORAGE_KEY, parsePersistedLayout);

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
    /**
     * Zen mode: a window-local overlay that hides both side bars, the Panel, the tab bars, and the status bar without
     * touching their stored visibility, so leaving it restores the layout exactly. Never persisted; every launch starts
     * outside it. Read surface visibility through {@link isPrimarySidebarShown} and {@link isPanelShown}, never the raw
     * flags. Any request that reveals a hidden surface (its toggle, a reveal command) leaves Zen first, so a command
     * never reveals something the user cannot see.
     */
    zenMode: boolean;
    toggleZenMode(): void;
    setPrimarySidebarWidth(width: number): void;
    setSecondarySidebarWidth(width: number): void;
    setPanelHeight(height: number): void;
    resetPrimarySidebarWidth(): void;
    resetSecondarySidebarWidth(): void;
    resetPanelHeight(): void;
    /**
     * Reveals or hides the PrimarySidebar. Revealing preserves the current workbench focus because
     * `primarySidebar.focus` is the explicit keyboard-entry command; hiding still hands focus back when the side bar
     * owned it.
     */
    togglePrimarySidebar(): void;
    /**
     * Reveals or hides the SecondarySidebar and hands keyboard focus over with it; see {@link handOffChromeFocus}.
     */
    toggleSecondarySidebar(): void;
    /**
     * Reveals or hides the Panel and hands keyboard focus over with it; see {@link handOffChromeFocus}.
     *
     * The handoff is deliberately limited to the three toggles, which are always a user gesture. The programmatic
     * setters below and {@link ChromeLayoutState.activatePanelViewContainer} also reveal a surface, but an extension's
     * `view.reveal` reaches them too, and taking the keyboard away from a Terminal because a background provider asked
     * for attention is the theft this rule exists to prevent: VS Code's own `TreeView.reveal` defaults `focus` to false
     * for the same reason. Giving those paths an explicit opt-in is follow-up work, not a silent default.
     */
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
     * Swaps the Primary Side Bar between the Project tree and the Activity queue. Unlike the visibility toggles this
     * never moves keyboard focus on its own: both modes own a roving Tab stop of their own, and `primarySidebar.focus`
     * stays the explicit entry command for either one.
     */
    togglePrimarySidebarActivityMode(): void;
    /**
     * Reveals the Primary Side Bar in Activity mode, for commands that have somewhere to put the user in the queue.
     */
    showPrimarySidebarActivity(): void;
    /**
     * Returns the Primary Side Bar to the Project tree and persists it. The way out when the Activity body cannot
     * render: a persisted Activity mode would otherwise re-mount the failing body on every reload.
     */
    leavePrimarySidebarActivityMode(): void;
    /**
     * Re-clamps the persisted layout against a new viewport; see {@link clampLayoutToViewport} and
     * {@link clampPanelHeight}.
     */
    clampToViewport(viewportWidth: number, viewportHeight: number): void;
    setPortalWidth(width: number): void;
}

function pickLayout(state: ChromeLayout): ChromeLayout {
    return {
        primarySidebarWidth: state.primarySidebarWidth,
        secondarySidebarWidth: state.secondarySidebarWidth,
        portalWidth: state.portalWidth,
        panelHeight: state.panelHeight,
        primarySidebarVisible: state.primarySidebarVisible,
        secondarySidebarVisible: state.secondarySidebarVisible,
        panelVisible: state.panelVisible,
        desiredPanelViewContainerId: state.desiredPanelViewContainerId,
        primarySidebarActivityMode: state.primarySidebarActivityMode,
    };
}

export const useChromeLayoutStore = createStore<ChromeLayoutState>('chrome-layout', (set, get) => {
    /**
     * Persists the fields of `layout` that differ from this window's current layout. Call it before `set`, while the
     * store still holds the previous values.
     */
    const writePersistedLayout = (layout: ChromeLayout): void => {
        const current = pickLayout(get());
        const changes: Record<string, unknown> = {};
        for (const field of Object.keys(layout) as Array<keyof ChromeLayout>)
            if (layout[field] !== current[field]) changes[field] = layout[field];
        if (Object.keys(changes).length > 0) sharedLayout.patch(changes);
    };
    return {
        ...sharedLayout.read(),
        zenMode: false,
        toggleZenMode() {
            const isEntering = !get().zenMode;
            if (isEntering) {
                // Before `set`, so a focused side bar row or Panel view hands the keyboard back before it unmounts.
                handOffChromeFocus('primarySidebar', false);
                handOffChromeFocus('secondarySidebar', false);
                handOffChromeFocus('panel', false);
                // The status bar bell that owns the center unmounts with Zen, which would leave it open and mark every
                // notice that arrives meanwhile as read.
                useNotificationStore.getState().setOpen(false);
            }
            set({ zenMode: isEntering });
        },
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
            if (get().zenMode) {
                set({ zenMode: false });
                if (get().primarySidebarVisible) return;
            }
            const isPrimarySidebarVisible = !get().primarySidebarVisible;
            const layout = fitCurrentViewport({
                ...pickLayout(get()),
                primarySidebarVisible: isPrimarySidebarVisible,
            });
            // `Cmd+0` owns keyboard entry into the Primary Side Bar. `Cmd+[` only changes visibility, matching its command
            // description and preserving the Terminal/editor caret; when hiding, the handoff still rescues focus from a
            // row that is about to unmount.
            if (!isPrimarySidebarVisible) handOffChromeFocus('primarySidebar', false);
            writePersistedLayout(layout);
            set(layout);
        },
        toggleSecondarySidebar() {
            if (get().zenMode) {
                set({ zenMode: false });
                if (get().secondarySidebarVisible) return;
            }
            const isRevealing = !get().secondarySidebarVisible;
            const layout = fitCurrentViewport({
                ...pickLayout(get()),
                secondarySidebarVisible: isRevealing,
            });
            // Same contract as the Panel: `Cmd+]` reaches through a focused Terminal too, so it owes the same handoff.
            handOffChromeFocus('secondarySidebar', isRevealing);
            writePersistedLayout(layout);
            set(layout);
        },
        setPrimarySidebarVisible(isVisible) {
            const layout = fitCurrentViewport({
                ...pickLayout(get()),
                primarySidebarVisible: isVisible,
            });
            writePersistedLayout(layout);
            set({ ...layout, ...(isVisible && { zenMode: false }) });
        },
        setSecondarySidebarVisible(isVisible) {
            const layout = fitCurrentViewport({
                ...pickLayout(get()),
                secondarySidebarVisible: isVisible,
            });
            writePersistedLayout(layout);
            set({ ...layout, ...(isVisible && { zenMode: false }) });
        },
        togglePanel() {
            if (get().zenMode) {
                set({ zenMode: false });
                if (get().panelVisible) return;
            }
            const isRevealing = !get().panelVisible;
            const layout = fitCurrentViewport({ ...pickLayout(get()), panelVisible: isRevealing });
            // Before `set`, so the handoff still sees the element that owns focus and the Panel that is about to unmount.
            handOffChromeFocus('panel', isRevealing);
            writePersistedLayout(layout);
            set(layout);
        },
        setPanelVisible(isVisible) {
            const layout = fitCurrentViewport({
                ...pickLayout(get()),
                panelVisible: isVisible,
            });
            writePersistedLayout(layout);
            set({ ...layout, ...(isVisible && { zenMode: false }) });
        },
        togglePrimarySidebarActivityMode() {
            const isActivityMode = !get().primarySidebarActivityMode;
            const layout = { ...pickLayout(get()), primarySidebarActivityMode: isActivityMode };
            // Before the commit: the body that owns focus right now is the one about to unmount.
            refocusChromeSurfaceBody('primarySidebar');
            writePersistedLayout(layout);
            set(layout);
        },
        leavePrimarySidebarActivityMode() {
            if (!get().primarySidebarActivityMode) return;
            const layout = { ...pickLayout(get()), primarySidebarActivityMode: false };
            refocusChromeSurfaceBody('primarySidebar');
            writePersistedLayout(layout);
            set(layout);
        },
        showPrimarySidebarActivity() {
            const layout = fitCurrentViewport({
                ...pickLayout(get()),
                primarySidebarVisible: true,
                primarySidebarActivityMode: true,
            });
            refocusChromeSurfaceBody('primarySidebar');
            writePersistedLayout(layout);
            set({ ...layout, zenMode: false });
        },
        activatePanelViewContainer(view) {
            const layout = fitCurrentViewport({
                ...pickLayout(get()),
                panelVisible: true,
                desiredPanelViewContainerId: view,
            });
            writePersistedLayout(layout);
            set({ ...layout, zenMode: false });
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
        setPortalWidth(width) {
            const portalWidth = clampWidth(width, PORTAL_MIN_WIDTH, PORTAL_MAX_WIDTH);
            writePersistedLayout({ ...pickLayout(get()), portalWidth });
            set({ portalWidth });
        },
    };
});

/**
 * Whether the Primary Side Bar is on screen: its stored preference, unless Zen mode hides it.
 */
export function isPrimarySidebarShown(
    state: Pick<ChromeLayoutState, 'primarySidebarVisible' | 'zenMode'>,
): boolean {
    return state.primarySidebarVisible && !state.zenMode;
}

/**
 * Whether the Panel is on screen: its stored preference, unless Zen mode hides it.
 */
export function isPanelShown(state: Pick<ChromeLayoutState, 'panelVisible' | 'zenMode'>): boolean {
    return state.panelVisible && !state.zenMode;
}

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
