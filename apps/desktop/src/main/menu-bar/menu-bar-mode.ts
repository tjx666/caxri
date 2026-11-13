import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { MenuItemConstructorOptions } from 'electron';

import type { RunningWork } from '../confirmations';
import type { MenuBarActions, MenuBarSnapshot } from './menu-bar-menu';
import { buildMenuBarMenu, menuBarTitle, menuBarTooltip } from './menu-bar-menu';

/**
 * Closed reason for `window.menu_bar_left`.
 */
type MenuBarLeaveReason = 'open-session' | 'open-window' | 'quit' | 'setting-off';

/**
 * The parts of an Electron `Tray` the mode drives.
 */
export interface MenuBarTray {
    destroy: () => void;
    setContextMenu: (template: MenuItemConstructorOptions[]) => void;
    setTitle: (title: string) => void;
    setToolTip: (tooltip: string) => void;
}

export interface MenuBarModeOptions {
    actions: Omit<MenuBarActions, 'openSession'> & {
        openSession: (sessionId: string) => Promise<void>;
    };
    createTray: () => MenuBarTray;
    /**
     * MacOS's Dock icon; absent on other platforms, where the mode only adds the tray.
     */
    dock: { hide: () => void; show: () => Promise<void> | void } | undefined;
    /**
     * Whether a Workbench window is open, checked after every await so a window reopened meanwhile wins.
     */
    hasOpenWindow: () => boolean;
    /**
     * `window.menuBarWhenClosed`.
     */
    isEnabled: () => Promise<boolean>;
    logger: () => StructuredLogger | undefined;
    now?: () => number;
    readRunning: () => Promise<RunningWork>;
    readSnapshot: () => Promise<MenuBarSnapshot>;
    /**
     * Shown the first time Caxri ever enters the menu bar, so the Dock icon vanishing is never a mystery.
     */
    showIntroOnce: () => void;
}

export interface MenuBarMode {
    isActive(): boolean;
    /**
     * Follows Server events while active: state changes redraw the menu, a settings change may end the mode.
     */
    observe(event: ServerEvent): void;
    /**
     * Ends the mode once a quit is accepted, so the status item does not outlive the quit and the windows the quit
     * closes do not enter it again.
     */
    quitting(): void;
    /**
     * Called after any window closed. Enters the mode once no window is left open, the setting allows it, and work is
     * still running; with nothing running, closing the window keeps Caxri's ordinary Dock presence.
     */
    windowClosed(): Promise<void>;
    /**
     * Called when any window is created, which ends the mode: a window never shows without its Dock icon.
     */
    windowOpening(): void;
}

/**
 * How long a burst of Server events is coalesced into one menu redraw.
 */
export const MENU_BAR_REFRESH_MS = 300;

/**
 * Caxri's unattended presence: with the window closed and work still running, Caxri leaves the Dock and keeps a status
 * item in the menu bar that says how many Agents work and which Sessions need the user. The Renderer, the largest idle
 * cost, is gone with its window; Main stays so notifications keep arriving and the user can come back in one click. The
 * status item follows Superset's tray; entering only while work runs and hiding the Dock icon are Caxri's own. See
 * docs/unattended-mode.md.
 */
export function createMenuBarMode(options: MenuBarModeOptions): MenuBarMode {
    const now = options.now ?? Date.now;
    let tray: MenuBarTray | undefined;
    let enteredAt = 0;
    let sessionOpens = 0;
    let pendingLeaveReason: MenuBarLeaveReason | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let isEntering = false;
    let isQuitting = false;
    const isActive = (): boolean => tray !== undefined;
    const hasQuit = (): boolean => isQuitting;

    const leave = (reason: MenuBarLeaveReason): void => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = undefined;
        const current = tray;
        if (!current) return;
        tray = undefined;
        current.destroy();
        void options.dock?.show();
        options.logger()?.write('info', logEventCatalog.window.menuBarLeft, {
            durationMs: now() - enteredAt,
            fields: { reason, sessionOpens },
        });
    };

    const actions: MenuBarActions = {
        ...options.actions,
        openSession: (sessionId) => {
            sessionOpens += 1;
            pendingLeaveReason = 'open-session';
            void options.actions.openSession(sessionId).finally(() => {
                pendingLeaveReason = undefined;
            });
        },
        openWindow: () => {
            pendingLeaveReason = 'open-window';
            options.actions.openWindow();
            pendingLeaveReason = undefined;
        },
        quit: () => options.actions.quit(),
        setKeepAwake: (isEnabled) => options.actions.setKeepAwake(isEnabled),
    };

    const redraw = async (): Promise<void> => {
        let snapshot: MenuBarSnapshot | undefined;
        try {
            snapshot = await options.readSnapshot();
        } catch {
            // Unreachable Server: keep the app actions so the user can still come back or quit.
        }
        if (!tray) return;
        tray.setTitle(menuBarTitle(snapshot?.summary));
        tray.setToolTip(menuBarTooltip(snapshot?.summary));
        tray.setContextMenu(buildMenuBarMenu(snapshot, actions));
    };

    const scheduleRedraw = (): void => {
        if (!tray || refreshTimer) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void redraw();
        }, MENU_BAR_REFRESH_MS);
    };

    const recheckSetting = async (): Promise<void> => {
        let isEnabled: boolean;
        try {
            isEnabled = await options.isEnabled();
        } catch {
            return;
        }
        if (!isEnabled) leave('setting-off');
    };

    return {
        isActive,
        observe: (event) => {
            if (!tray) return;
            if (event.event === 'settings.changed') void recheckSetting();
            if (event.event === 'state.changed' || event.event === 'settings.changed')
                scheduleRedraw();
        },
        quitting: () => {
            isQuitting = true;
            leave('quit');
        },
        windowClosed: async () => {
            if (tray || isEntering || isQuitting) return;
            isEntering = true;
            try {
                const [isEnabled, running] = await Promise.all([
                    options.isEnabled(),
                    options.readRunning(),
                ]);
                if (!isEnabled || running.chats + running.terminals === 0) return;
                // A window reopened, another close entered, or the quit was accepted while the reads were in flight.
                if (isActive() || hasQuit() || options.hasOpenWindow()) return;
                tray = options.createTray();
                enteredAt = now();
                sessionOpens = 0;
                options.dock?.hide();
                options.logger()?.write('info', logEventCatalog.window.menuBarEntered, {
                    fields: { runningChats: running.chats, runningTerminals: running.terminals },
                });
                options.showIntroOnce();
                await redraw();
            } catch {
                // An unreachable Server keeps the ordinary Dock presence; the window can still be reopened from it.
            } finally {
                isEntering = false;
            }
        },
        windowOpening: () => leave(pendingLeaveReason ?? 'open-window'),
    };
}
