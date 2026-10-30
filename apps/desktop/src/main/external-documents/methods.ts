import type { MainRequest, ServerEvent } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';
import { dialog, shell } from 'electron';

import type { DesktopServerConnection } from '../connection/server-connection';
import { requestWindowOr } from '../request-window';
import {
    openLinkedExternalDocument,
    readExternalDocument,
    readExternalDocumentAsset,
} from './reads';
import { externalDocumentDirectory, externalDocumentPath, writeExternalDocument } from './registry';
import { saveUntitledEditor } from './snapshot';
import type { ExternalDocumentWatcher } from './watcher';
import { createExternalDocumentWatcher } from './watcher';

/**
 * Every `externalDocument.*` method, plus Save As of an untitled Editor buffer, whose result is an external document.
 */
type ExternalDocumentRequest = Extract<
    MainRequest,
    { method: `externalDocument.${string}` | 'editor.saveUntitled' }
>;

export function isExternalDocumentRequest(
    request: MainRequest,
): request is ExternalDocumentRequest {
    return (
        request.method.startsWith('externalDocument.') || request.method === 'editor.saveUntitled'
    );
}

export interface ExternalDocumentContext {
    watcher: Pick<ExternalDocumentWatcher, 'setWatched'>;
    /**
     * The window a Save As sheet attaches to: the requesting window, else the Workbench.
     */
    parentWindow(): BrowserWindow;
}

export function createExternalDocumentContext(options: {
    sendEvent?: (event: ServerEvent) => void;
    getWindow(): BrowserWindow | undefined;
}): ExternalDocumentContext {
    return {
        watcher: createExternalDocumentChangeWatcher(options.sendEvent),
        parentWindow: () => requestWindowOr(options.getWindow()),
    };
}

/**
 * The watcher behind `externalDocument.watch`, reporting changes through `sendEvent`. Without a sender (a unit-test
 * handler) watch requests are accepted and ignored.
 */
function createExternalDocumentChangeWatcher(
    sendEvent: ((event: ServerEvent) => void) | undefined,
): Pick<ExternalDocumentWatcher, 'setWatched'> {
    if (!sendEvent) return { setWatched: () => {} };
    return createExternalDocumentWatcher({
        emit: (documentId) =>
            sendEvent({ event: 'externalDocument.changed', payload: { documentId } }),
    });
}

/**
 * Main's half of every `externalDocument.*` method and of `editor.saveUntitled`. `openInTerminal` crosses into Server
 * Core through the Main-only `terminal.createInExternalDirectory`, carrying the folder Main resolved from the ID.
 */
export async function handleExternalDocumentRequest(
    request: ExternalDocumentRequest,
    server: Pick<DesktopServerConnection, 'request'>,
    context: ExternalDocumentContext,
): Promise<unknown> {
    switch (request.method) {
        case 'externalDocument.write':
            return writeExternalDocument(request.params.documentId, request.params.content);
        case 'externalDocument.read':
            return readExternalDocument(request.params.documentId);
        case 'externalDocument.watch':
            context.watcher.setWatched(request.params.documentIds);
            return null;
        case 'externalDocument.readAsset':
            return readExternalDocumentAsset(request.params.documentId, request.params.path);
        case 'externalDocument.openLinked':
            return openLinkedExternalDocument(request.params.documentId, request.params.path);
        case 'externalDocument.reveal':
            shell.showItemInFolder(await externalDocumentPath(request.params.documentId));
            return null;
        case 'externalDocument.openWithDefaultApp': {
            // `shell.openPath` resolves with an error message instead of rejecting; see `createDesktopActions`.
            const failure = await shell.openPath(
                await externalDocumentPath(request.params.documentId),
            );
            if (failure) throw new CaxriError('IO', failure);
            return null;
        }
        case 'editor.saveUntitled':
            return saveUntitledEditor(
                (dialogOptions) => dialog.showSaveDialog(context.parentWindow(), dialogOptions),
                request.params,
            );
        case 'externalDocument.openInTerminal':
            return server.request('terminal.createInExternalDirectory', {
                sessionId: request.params.sessionId,
                cwd: await externalDocumentDirectory(request.params.documentId),
            });
    }
}
