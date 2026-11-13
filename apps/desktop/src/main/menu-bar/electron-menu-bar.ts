import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StructuredLogger } from '@caxri/system';
import type { NativeImage } from 'electron';
import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';

import type { DesktopServerConnection } from '../connection/server-connection';
import { translateMain as t } from '../locale';
import type { AgentNotificationDelivery } from '../notifications/agent-notification-delivery';
import { activateAgentNotificationSession } from '../notifications/agent-notification-runtime';
import { MENU_BAR_GLYPH_POINTS, renderMenuBarGlyph } from './menu-bar-glyph';
import type { MenuBarMode, MenuBarTray } from './menu-bar-mode';
import { createMenuBarMode } from './menu-bar-mode';

/**
 * Marker file under the profile recording that the menu bar introduction was shown, so it appears once per profile.
 */
const INTRO_MARKER = 'menu-bar-intro-shown';

function createGlyphImage(): NativeImage {
    const image = nativeImage.createEmpty();
    for (const scaleFactor of [1, 2]) {
        const size = MENU_BAR_GLYPH_POINTS * scaleFactor;
        image.addRepresentation({
            scaleFactor,
            width: size,
            height: size,
            buffer: renderMenuBarGlyph(size),
        });
    }
    image.setTemplateImage(true);
    return image;
}

function createElectronTray(): MenuBarTray {
    const tray = new Tray(createGlyphImage());
    return {
        destroy: () => tray.destroy(),
        setContextMenu: (template) => tray.setContextMenu(Menu.buildFromTemplate(template)),
        setTitle: (title) => tray.setTitle(title),
        setToolTip: (tooltip) => tray.setToolTip(tooltip),
    };
}

/**
 * Any window the user can see counts, a Process Explorer or Caxri Bot window included: a visible window without a Dock
 * icon would be stranded.
 */
function hasVisibleWindow(): boolean {
    return BrowserWindow.getAllWindows().some(
        (window) => !window.isDestroyed() && window.isVisible(),
    );
}

/**
 * Binds the menu bar mode to Electron and the Desktop Server connection. It follows every window itself: a window
 * created ends the mode, and a closed one may start it. Main's quit acceptance ends it through `quitting`.
 */
export function createElectronMenuBarMode(options: {
    delivery: AgentNotificationDelivery;
    focusMainWindow: (windowKey?: string) => Promise<BrowserWindow>;
    logger: () => StructuredLogger | undefined;
    supervisor: DesktopServerConnection;
}): MenuBarMode {
    const { supervisor } = options;
    const introMarker = join(app.getPath('userData'), INTRO_MARKER);
    const openWindow = (): void => {
        void options.focusMainWindow().catch(() => {});
    };
    const mode = createMenuBarMode({
        actions: {
            openSession: async (sessionId) => {
                try {
                    await activateAgentNotificationSession(
                        { focusMainWindow: options.focusMainWindow, supervisor },
                        sessionId,
                    );
                } catch {
                    // A Session deleted meanwhile, or an unreachable Server: Caxri still opens on its last view.
                }
            },
            openWindow,
            quit: () => {
                // With the Dock icon hidden Caxri is not the active app, so its quit prompt would open behind others.
                app.focus({ steal: true });
                app.quit();
            },
            setKeepAwake: (isEnabled) => {
                void supervisor
                    .request('settings.patch', {
                        changes: [{ key: 'power.keepAwakeWhileAgentsWork', value: isEnabled }],
                    })
                    .catch(() => {});
            },
        },
        createTray: createElectronTray,
        dock: app.dock,
        hasOpenWindow: hasVisibleWindow,
        isEnabled: async () =>
            (await supervisor.request('settings.get')).value['window.menuBarWhenClosed'],
        logger: options.logger,
        readRunning: () => supervisor.request('terminal.runningCount'),
        readSnapshot: async () => {
            const [summary, status, settings] = await Promise.all([
                supervisor.request('session.workSummary', {}),
                supervisor.request('host.status'),
                supervisor.request('settings.get'),
            ]);
            return {
                summary,
                isKeepingAwake: status.keepAwake.active,
                isKeepAwakeEnabled: settings.value['power.keepAwakeWhileAgentsWork'],
            };
        },
        showIntroOnce: () => {
            void (async () => {
                try {
                    await access(introMarker);
                    return;
                } catch {
                    // Not shown yet.
                }
                await writeFile(introMarker, '');
                options.delivery.show(
                    {
                        id: 'menu-bar-intro',
                        groupId: 'menu-bar',
                        title: t('desktop.menuBar.introTitle'),
                        body: t('desktop.menuBar.introBody'),
                    },
                    openWindow,
                );
            })().catch(() => {});
        },
    });
    const follow = (window: BrowserWindow): void => {
        window.once('closed', () => {
            void mode.windowClosed();
        });
    };
    // Windows opened before the Server attached (the primary Workbench window) are followed from here on.
    for (const window of BrowserWindow.getAllWindows()) follow(window);
    app.on('browser-window-created', (_event, window) => {
        mode.windowOpening();
        follow(window);
    });
    return mode;
}
