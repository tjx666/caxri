import { beforeEach, describe, expect, it } from 'vitest';

import type { ChromeLayout } from './chrome-layout';
import {
    clampLayoutToViewport,
    clampPanelHeight,
    clampWidth,
    isPanelShown,
    isPrimarySidebarShown,
    isSecondarySidebarShownFor,
    MIN_MAIN_WIDTH,
    MIN_WORK_SURFACE_HEIGHT,
    PANEL_DEFAULT_HEIGHT,
    PANEL_DIVIDER_WIDTH,
    PANEL_MAX_HEIGHT,
    PANEL_MIN_HEIGHT,
    PRIMARY_SIDEBAR_DEFAULT_WIDTH,
    PRIMARY_SIDEBAR_MIN_WIDTH,
    SECONDARY_SIDEBAR_DEFAULT_WIDTH,
    SECONDARY_SIDEBAR_MIN_WIDTH,
    useChromeLayoutStore,
} from './chrome-layout';

describe('clampWidth', () => {
    it('holds a value already within bounds', () => {
        expect(clampWidth(300, 180, 480)).toBe(300);
    });

    it('floors a value below the minimum', () => {
        expect(clampWidth(50, 180, 480)).toBe(180);
    });

    it('ceils a value above the maximum', () => {
        expect(clampWidth(900, 180, 480)).toBe(480);
    });

    it('falls back to the minimum for a non-finite width', () => {
        expect(clampWidth(NaN, 180, 480)).toBe(180);
        expect(clampWidth(Infinity, 180, 480)).toBe(180);
    });
});

describe('clampLayoutToViewport', () => {
    const wideLayout: ChromeLayout = {
        primarySidebarWidth: PRIMARY_SIDEBAR_DEFAULT_WIDTH,
        secondarySidebarWidth: SECONDARY_SIDEBAR_DEFAULT_WIDTH,
        panelHeight: PANEL_DEFAULT_HEIGHT,
        primarySidebarVisible: true,
        secondarySidebarVisible: true,
        panelVisible: false,
        desiredPanelViewContainerId: 'caxri.logs',
        primarySidebarActivityMode: false,
    };

    it('leaves widths untouched when the viewport has plenty of room', () => {
        expect(clampLayoutToViewport(wideLayout, 1600)).toEqual(wideLayout);
    });

    it('shrinks the SecondarySidebar before the PrimarySidebar as the viewport narrows', () => {
        const viewportWidth =
            PRIMARY_SIDEBAR_DEFAULT_WIDTH +
            SECONDARY_SIDEBAR_DEFAULT_WIDTH +
            MIN_MAIN_WIDTH +
            PANEL_DIVIDER_WIDTH * 2 -
            40;

        const next = clampLayoutToViewport(wideLayout, viewportWidth);

        expect(next.primarySidebarWidth).toBe(PRIMARY_SIDEBAR_DEFAULT_WIDTH);
        expect(next.secondarySidebarWidth).toBe(SECONDARY_SIDEBAR_DEFAULT_WIDTH - 40);
    });

    it('shrinks the PrimarySidebar once the SecondarySidebar has reached its minimum', () => {
        const viewportWidth =
            PRIMARY_SIDEBAR_DEFAULT_WIDTH +
            SECONDARY_SIDEBAR_MIN_WIDTH +
            MIN_MAIN_WIDTH +
            PANEL_DIVIDER_WIDTH * 2 -
            20;

        const next = clampLayoutToViewport(wideLayout, viewportWidth);

        expect(next.secondarySidebarWidth).toBe(SECONDARY_SIDEBAR_MIN_WIDTH);
        expect(next.primarySidebarWidth).toBe(PRIMARY_SIDEBAR_DEFAULT_WIDTH - 20);
    });

    it('never shrinks either panel below its own minimum, even in a very narrow viewport', () => {
        const next = clampLayoutToViewport(wideLayout, 200);

        expect(next.primarySidebarWidth).toBe(PRIMARY_SIDEBAR_MIN_WIDTH);
        expect(next.secondarySidebarWidth).toBe(SECONDARY_SIDEBAR_MIN_WIDTH);
    });

    it('ignores the SecondarySidebar width in the overflow budget once it is collapsed', () => {
        const collapsed: ChromeLayout = { ...wideLayout, secondarySidebarVisible: false };
        const viewportWidth =
            PRIMARY_SIDEBAR_DEFAULT_WIDTH + MIN_MAIN_WIDTH + PANEL_DIVIDER_WIDTH + 10;

        const next = clampLayoutToViewport(collapsed, viewportWidth);

        expect(next.primarySidebarWidth).toBe(PRIMARY_SIDEBAR_DEFAULT_WIDTH);
        expect(next.secondarySidebarVisible).toBe(false);
    });

    it('ignores the PrimarySidebar width in the overflow budget once it is collapsed', () => {
        const collapsed: ChromeLayout = { ...wideLayout, primarySidebarVisible: false };
        const viewportWidth =
            SECONDARY_SIDEBAR_DEFAULT_WIDTH + MIN_MAIN_WIDTH + PANEL_DIVIDER_WIDTH + 10;

        const next = clampLayoutToViewport(collapsed, viewportWidth);

        expect(next.secondarySidebarWidth).toBe(SECONDARY_SIDEBAR_DEFAULT_WIDTH);
        expect(next.primarySidebarVisible).toBe(false);
    });

    it('clamps an out-of-range persisted width even when the viewport is not the constraint', () => {
        const stale: ChromeLayout = { ...wideLayout, primarySidebarWidth: 10_000 };

        const next = clampLayoutToViewport(stale, 1600);

        expect(next.primarySidebarWidth).toBeLessThanOrEqual(480);
    });

    it('carries the Panel fields through untouched: the vertical axis is clamped separately', () => {
        const withPanel: ChromeLayout = {
            ...wideLayout,
            panelVisible: true,
            desiredPanelViewContainerId: 'caxri.info',
            panelHeight: 400,
        };

        const next = clampLayoutToViewport(withPanel, 200);

        expect(next.panelVisible).toBe(true);
        expect(next.desiredPanelViewContainerId).toBe('caxri.info');
        expect(next.panelHeight).toBe(400);
    });
});

describe('clampPanelHeight', () => {
    it('holds a height that leaves the work surface enough room', () => {
        expect(clampPanelHeight(300, 1000)).toBe(300);
    });

    it('shrinks a height that would crowd the work surface below its minimum', () => {
        const viewportHeight = 600;

        const height = clampPanelHeight(500, viewportHeight);

        expect(height).toBe(viewportHeight - MIN_WORK_SURFACE_HEIGHT - PANEL_DIVIDER_WIDTH);
        expect(height + MIN_WORK_SURFACE_HEIGHT + PANEL_DIVIDER_WIDTH).toBeLessThanOrEqual(
            viewportHeight,
        );
    });

    it('never shrinks below its own minimum, even in a viewport too short for both', () => {
        expect(clampPanelHeight(PANEL_DEFAULT_HEIGHT, 200)).toBe(PANEL_MIN_HEIGHT);
    });

    it('clamps an out-of-range persisted height before the viewport is considered', () => {
        expect(clampPanelHeight(10_000, 100_000)).toBe(PANEL_MAX_HEIGHT);
        expect(clampPanelHeight(10, 100_000)).toBe(PANEL_MIN_HEIGHT);
    });

    it('falls back to the bounded height when the viewport height is not a finite number', () => {
        expect(clampPanelHeight(300, NaN)).toBe(300);
    });
});

describe('Primary Side Bar Activity mode', () => {
    beforeEach(() => {
        useChromeLayoutStore.setState({
            primarySidebarActivityMode: false,
            primarySidebarVisible: true,
        });
    });

    it('swaps the side bar body back and forth', () => {
        useChromeLayoutStore.getState().togglePrimarySidebarActivityMode();
        expect(useChromeLayoutStore.getState().primarySidebarActivityMode).toBe(true);

        useChromeLayoutStore.getState().togglePrimarySidebarActivityMode();
        expect(useChromeLayoutStore.getState().primarySidebarActivityMode).toBe(false);
    });

    /**
     * Toggling the mode must not also toggle the side bar: `Cmd+[` owns visibility, and a mode switch that revealed a
     * side bar the user had deliberately collapsed would make the bell a second, surprising show command.
     */
    it('leaves visibility alone', () => {
        useChromeLayoutStore.setState({ primarySidebarVisible: false });

        useChromeLayoutStore.getState().togglePrimarySidebarActivityMode();

        expect(useChromeLayoutStore.getState().primarySidebarVisible).toBe(false);
        expect(useChromeLayoutStore.getState().primarySidebarActivityMode).toBe(true);
    });

    /**
     * `session.focusNextAttention` is the exception: it has a queue position to put the user in, so it reveals the bar
     * rather than selecting a Session behind a surface nobody can see.
     */
    it('reveals a collapsed side bar when a command shows the queue', () => {
        useChromeLayoutStore.setState({ primarySidebarVisible: false });

        useChromeLayoutStore.getState().showPrimarySidebarActivity();

        expect(useChromeLayoutStore.getState().primarySidebarVisible).toBe(true);
        expect(useChromeLayoutStore.getState().primarySidebarActivityMode).toBe(true);
    });

    it('stays in Activity mode when asked again', () => {
        useChromeLayoutStore.getState().showPrimarySidebarActivity();
        useChromeLayoutStore.getState().showPrimarySidebarActivity();

        expect(useChromeLayoutStore.getState().primarySidebarActivityMode).toBe(true);
    });
});

describe('SecondarySidebar yield', () => {
    const scope = 'session-1:project-1';
    const isShown = (yieldScope?: string): boolean => {
        const state = useChromeLayoutStore.getState();
        return isSecondarySidebarShownFor(
            state.secondarySidebarVisible,
            yieldScope,
            state.secondarySidebarRevealedScope,
        );
    };

    beforeEach(() => {
        useChromeLayoutStore.setState({
            secondarySidebarVisible: true,
            secondarySidebarRevealedScope: undefined,
        });
    });

    it('yields while a scope holds a pane beside its Chat', () => {
        expect(isShown()).toBe(true);
        expect(isShown(scope)).toBe(false);
    });

    it('reveals a yielding SecondarySidebar on toggle and keeps the stored preference', () => {
        useChromeLayoutStore.getState().toggleSecondarySidebar(scope);
        expect(isShown(scope)).toBe(true);
        expect(useChromeLayoutStore.getState().secondarySidebarVisible).toBe(true);
    });

    it('hides a revealed SecondarySidebar back into the yield, not into a stored hide', () => {
        useChromeLayoutStore.getState().toggleSecondarySidebar(scope);
        useChromeLayoutStore.getState().toggleSecondarySidebar(scope);
        expect(isShown(scope)).toBe(false);
        expect(isShown()).toBe(true);
    });

    it('reveals a stored hide inside a yield without turning the preference on', () => {
        useChromeLayoutStore.setState({ secondarySidebarVisible: false });
        useChromeLayoutStore.getState().toggleSecondarySidebar(scope);
        expect(isShown(scope)).toBe(true);
        useChromeLayoutStore.getState().toggleSecondarySidebar(scope);
        useChromeLayoutStore.getState().syncSecondarySidebarYieldScope(undefined);
        expect(useChromeLayoutStore.getState().secondarySidebarVisible).toBe(false);
        expect(isShown()).toBe(false);
    });

    it('lets a view command override the yield and leaves a stored hide alone', () => {
        useChromeLayoutStore.setState({ secondarySidebarVisible: false });
        useChromeLayoutStore.getState().setSecondarySidebarVisible(true, scope);
        expect(isShown(scope)).toBe(true);
        expect(useChromeLayoutStore.getState().secondarySidebarVisible).toBe(false);
    });

    it('does not carry a reveal into another scope', () => {
        useChromeLayoutStore.getState().toggleSecondarySidebar(scope);
        expect(isShown('session-2:project-1')).toBe(false);
    });

    it('drops a reveal once its arrangement ends, so returning yields again', () => {
        useChromeLayoutStore.getState().toggleSecondarySidebar(scope);
        useChromeLayoutStore.getState().syncSecondarySidebarYieldScope(undefined);
        expect(isShown(scope)).toBe(false);
    });

    it('keeps a reveal while its arrangement holds', () => {
        useChromeLayoutStore.getState().toggleSecondarySidebar(scope);
        useChromeLayoutStore.getState().syncSecondarySidebarYieldScope(scope);
        expect(isShown(scope)).toBe(true);
    });

    it('hides normally without a yield', () => {
        useChromeLayoutStore.getState().toggleSecondarySidebar();
        expect(useChromeLayoutStore.getState().secondarySidebarVisible).toBe(false);
    });
});

describe('Zen Mode', () => {
    beforeEach(() => {
        useChromeLayoutStore.setState({
            zenMode: false,
            primarySidebarVisible: true,
            secondarySidebarVisible: true,
            secondarySidebarRevealedScope: undefined,
            panelVisible: true,
        });
    });

    it('hides every surface without touching the stored layout, and restores it on exit', () => {
        useChromeLayoutStore.getState().toggleZenMode();
        const state = useChromeLayoutStore.getState();
        expect(isPrimarySidebarShown(state)).toBe(false);
        expect(isPanelShown(state)).toBe(false);
        expect(state.primarySidebarVisible).toBe(true);
        expect(state.panelVisible).toBe(true);

        useChromeLayoutStore.getState().toggleZenMode();
        expect(isPrimarySidebarShown(useChromeLayoutStore.getState())).toBe(true);
        expect(isPanelShown(useChromeLayoutStore.getState())).toBe(true);
    });

    it('leaves Zen Mode and keeps a surface visible when its toggle runs inside Zen', () => {
        useChromeLayoutStore.getState().toggleZenMode();
        useChromeLayoutStore.getState().togglePanel();
        const state = useChromeLayoutStore.getState();
        expect(state.zenMode).toBe(false);
        expect(isPanelShown(state)).toBe(true);
    });

    it('leaves Zen Mode when a command reveals a surface', () => {
        useChromeLayoutStore.getState().toggleZenMode();
        useChromeLayoutStore.getState().setPrimarySidebarVisible(true);
        expect(useChromeLayoutStore.getState().zenMode).toBe(false);
    });

    it('stays in Zen Mode when a command hides a surface', () => {
        useChromeLayoutStore.getState().toggleZenMode();
        useChromeLayoutStore.getState().setPanelVisible(false);
        const state = useChromeLayoutStore.getState();
        expect(state.zenMode).toBe(true);
        expect(state.panelVisible).toBe(false);
    });
});
