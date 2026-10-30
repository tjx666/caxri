import type { CommandId } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { App, BaseWindow } from 'electron';
import { app, BrowserWindow, Menu } from 'electron';

import type { MainEnvironmentMethods } from './main-environment-methods';
import { unconfiguredEnvironment } from './main-environment-methods';
import { syncLocalMachineMenuItems } from './menu/template';
import type { SshHostEnvironments } from './ssh/host-environments';

/**
 * The local Workbench's `environment.*` and `sshHost.*` methods. It is always the local environment; it reaches the SSH
 * Host registry only to open a new SSH Host window or list hosts for the connect dialog. The registry is created once
 * Main's logger and local connection options exist, so `connect` fails as still starting until then.
 */
export function createLocalWorkbenchEnvironment(
    sshHostEnvironments: () => SshHostEnvironments | undefined,
): MainEnvironmentMethods {
    return {
        ...unconfiguredEnvironment,
        connect: async (destination) => {
            const environments = sshHostEnvironments();
            if (!environments) throw new CaxriError('UNAVAILABLE', 'Caxri is still starting');
            await environments.connect(destination);
        },
        listHosts: () =>
            sshHostEnvironments()?.methodsFor(undefined).listHosts() ??
            Promise.resolve({ hosts: [], recent: [] }),
        revealSshConfig: async () => {
            const environments = sshHostEnvironments();
            if (!environments) throw new CaxriError('UNAVAILABLE', 'Caxri is still starting');
            await environments.methodsFor(undefined).revealSshConfig();
        },
    };
}

export interface SshHostWindowMenu {
    /**
     * Routes an application menu command to the focused SSH Host window, which is a full Workbench of its own. Returns
     * `false` when `window` is not an SSH Host window, so the menu falls back to the local Workbench.
     */
    dispatch: (window: BaseWindow, command: CommandId, isViaAccelerator: boolean) => boolean;
    /**
     * Installs a freshly built application menu with the focused window's environment already applied.
     */
    setApplicationMenu: (menu: Menu) => void;
}

/**
 * The Electron surfaces the menu bar controller reads; tests substitute fakes.
 */
export interface SshHostWindowMenuHost {
    app: Pick<App, 'on'>;
    applicationMenu: () => Pick<Menu, 'getMenuItemById'> | null;
    focusedWindow: () => BrowserWindow | null;
    setApplicationMenu: (menu: Menu) => void;
}

const electronMenuHost: SshHostWindowMenuHost = {
    get app() {
        return app;
    },
    applicationMenu: () => Menu.getApplicationMenu(),
    focusedWindow: () => BrowserWindow.getFocusedWindow(),
    setApplicationMenu: (menu) => Menu.setApplicationMenu(menu),
};

/**
 * The menu bar's view of SSH Host windows. Besides routing commands, it disables local-machine-only items while an SSH
 * Host window is focused and re-enables them on blur, so a window that closes without another taking focus leaves the
 * menu in its local state.
 */
export function createSshHostWindowMenu(
    sshHostEnvironments: () => SshHostEnvironments | undefined,
    electron: SshHostWindowMenuHost = electronMenuHost,
): SshHostWindowMenu {
    const isLocalMachine = (window: BrowserWindow | null): boolean =>
        !sshHostEnvironments()?.forWindow(window ?? undefined);
    electron.app.on('browser-window-focus', (_event, window) =>
        syncLocalMachineMenuItems(electron.applicationMenu(), isLocalMachine(window)),
    );
    electron.app.on('browser-window-blur', () =>
        syncLocalMachineMenuItems(electron.applicationMenu(), true),
    );
    return {
        dispatch: (window, command, isViaAccelerator) => {
            const environment = sshHostEnvironments()?.forWindow(window as BrowserWindow);
            if (!environment) return false;
            environment.sendEvent({
                event: 'command.execute',
                payload: { command, viaAccelerator: isViaAccelerator },
            });
            return true;
        },
        setApplicationMenu: (menu) => {
            syncLocalMachineMenuItems(menu, isLocalMachine(electron.focusedWindow()));
            electron.setApplicationMenu(menu);
        },
    };
}
