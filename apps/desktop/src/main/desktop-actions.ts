import type { ServerEvent } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';
import { dialog, shell } from 'electron';

import { discardGitChangesPrompt } from './confirmations';
import type { DesktopOperationHandlers } from './desktop-operations';
import { launchExternalEditor } from './external-editor';

export interface DesktopActionDependencies {
    /**
     * An SSH Host's Server names paths on that host. Revealing or opening one here would act on whatever local file
     * happens to share the path, so those operations are refused instead.
     */
    environment?: 'local' | 'ssh';
    focusMainWindow: () => Promise<BrowserWindow>;
    getMainWindow: () => BrowserWindow | undefined;
    sendEvent: (event: ServerEvent) => void;
}

/**
 * The native side of every Server-routed Desktop operation, in one place so `index.ts` stays a composition root.
 *
 * Each handler receives a path Server Core already validated against the requesting Session's authorized Project root
 * and Main re-confirmed through `desktop-target.consume`; none of them may be reached with a Renderer-supplied path.
 */
function refuseSshHostPath(): never {
    throw new CaxriError(
        'UNAVAILABLE',
        'This file is on the SSH Host and cannot be opened on this computer',
    );
}

export function createDesktopActions({
    environment = 'local',
    focusMainWindow,
    getMainWindow,
    sendEvent,
}: DesktopActionDependencies): DesktopOperationHandlers {
    const isSshHost = environment === 'ssh';
    return {
        confirmGitDiscard: async (target) => {
            const result = await dialog.showMessageBox(
                getMainWindow()!,
                discardGitChangesPrompt(target),
            );
            return result.response === 0;
        },
        focus: async () => {
            await focusMainWindow();
        },
        open: (target) =>
            sendEvent({
                event: 'desktop.openRequested',
                payload: {
                    sessionId: target.sessionId,
                    kind: target.kind,
                    /**
                     * A directory carries its path so the Renderer can reveal it in Files; the Renderer treats the
                     * Session's own root (a plain `caxri open <project>`) as "select the Session" only.
                     */
                    path: target.path,
                    ...(target.location && { location: target.location }),
                    ...(target.focusEditor && { focusEditor: target.focusEditor }),
                },
            }),
        openInEditor: async (path, editorCommand) => {
            if (isSshHost) refuseSshHostPath();
            await launchExternalEditor(editorCommand, path);
        },
        /**
         * `shell.openPath` never rejects: it resolves with an error message string, and with an empty string when the
         * OS accepted the launch. Rethrowing that message is what turns "no application is registered for this file
         * type" into a Renderer toast instead of a click that silently does nothing.
         */
        openWithDefaultApp: async (path) => {
            if (isSshHost) refuseSshHostPath();
            const failure = await shell.openPath(path);
            if (failure) throw new Error(failure);
        },
        reveal: (path) => {
            if (isSshHost) refuseSshHostPath();
            shell.showItemInFolder(path);
        },
        status: () => {
            const window = getMainWindow();
            return window && !window.isDestroyed() ? 'window' : 'background';
        },
    };
}
