import { join } from 'node:path';
import process from 'node:process';

import type { BrowserWindow } from 'electron';
import { app, dialog } from 'electron';

import { shellCommandElevationPrompt } from './confirmations';
import type { ShellCommandEnvironment } from './shell-command';
import { runAsAdministrator, SHELL_COMMAND_LINK_PATH } from './shell-command';

/**
 * The Electron-backed environment for installing or removing the `caxri` shell command, asking for elevation in a
 * dialog attached to `window` while it is still open.
 */
export function createShellCommandEnvironment(
    window: BrowserWindow | undefined,
): ShellCommandEnvironment {
    return {
        launcherPath: app.isPackaged ? join(process.resourcesPath, 'bin', 'caxri') : undefined,
        linkPath: SHELL_COMMAND_LINK_PATH,
        confirmElevation: async (action) => {
            const prompt = shellCommandElevationPrompt(action, SHELL_COMMAND_LINK_PATH);
            const result =
                window && !window.isDestroyed()
                    ? await dialog.showMessageBox(window, prompt)
                    : await dialog.showMessageBox(prompt);
            return result.response === 0;
        },
        runElevated: runAsAdministrator,
    };
}
