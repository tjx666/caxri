import type { ServerEvent } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';
import { dialog, shell } from 'electron';

import { discardGitChangesPrompt } from './confirmations';
import type { DesktopOperationHandlers } from './desktop-operations';
import { launchExternalEditor } from './external-editor';

export interface DesktopActionDependencies {
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
export function createDesktopActions({
    focusMainWindow,
    getMainWindow,
    sendEvent,
}: DesktopActionDependencies): DesktopOperationHandlers {
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
                    ...(target.kind === 'file' && { path: target.path }),
                    ...(target.location && { location: target.location }),
                    ...(target.focusEditor && { focusEditor: target.focusEditor }),
                },
            }),
        openInEditor: (path, editorCommand) => launchExternalEditor(editorCommand, path),
        /**
         * `shell.openPath` never rejects: it resolves with an error message string, and with an empty string when the
         * OS accepted the launch. Rethrowing that message is what turns "no application is registered for this file
         * type" into a Renderer toast instead of a click that silently does nothing.
         */
        openWithDefaultApp: async (path) => {
            const failure = await shell.openPath(path);
            if (failure) throw new Error(failure);
        },
        reveal: (path) => shell.showItemInFolder(path),
        status: () => {
            const window = getMainWindow();
            return window && !window.isDestroyed() ? 'window' : 'background';
        },
    };
}
